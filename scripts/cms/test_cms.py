import difflib
import shutil
import uuid
from pathlib import Path

import pytest

import cms
from yamledit import Document, EditError, load

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture
def client(tmp_path):
    """The app on a copy of src/ (datasets, scripts, vendor and node_modules linked) so edits stay local."""
    src = tmp_path / "src"
    shutil.copytree(REPO / "src", src, ignore=lambda folder, names: ["datasets"] if Path(folder) == REPO / "src" else [])
    (src / "datasets").symlink_to(REPO / "src" / "datasets")
    for name in ("scripts", "vendor", "node_modules"):
        (tmp_path / name).symlink_to(REPO / name)
    cms.app.config.update(SRC=src, TESTING=True)
    yield cms.app.test_client()
    cms.app.config["SRC"] = REPO / "src"


def view(client, slug):
    return (cms.src() / "views" / slug / "view.yml").read_text(encoding="utf8")


def post(client, url, **body):
    return client.post(url, json=body, headers={"Origin": "http://127.0.0.1:8766"})


def changed_lines(before, after):
    return [line for line in difflib.ndiff(before.splitlines(), after.splitlines()) if line[:1] in "+-"]


def test_pages_render(client):
    for url in ["/", "/views/rounding", "/views/cohens-kappa", "/views/world-map", "/topics", "/datasets"]:
        assert client.get(url).status_code == 200, url
    overview = client.get("/").get_data(as_text=True)
    assert all(f'href="/views/{slug}"' in overview for slug in cms.folders("view"))
    assert len(cms.folders("view")) > 10


def test_set_changes_only_the_field(client):
    before = view(client, "rounding")
    old = load(before)["intro"]
    response = post(client, "/api/set", file="view", slug="rounding", path=["intro"], value="Round it.", old=old)
    assert response.json == {"ok": True, "check": {"ok": True, "error": None}}
    after = view(client, "rounding")
    assert load(after)["intro"] == "Round it."
    assert sorted(changed_lines(before, after)) == sorted([f"- intro: {before.split('intro: ')[1].splitlines()[0]}",
                                                           "-   you whether to round up.", "+ intro: Round it."])


def test_required_field_and_stale_value_are_rejected(client):
    before = view(client, "rounding")
    title = load(before)["title"]
    assert post(client, "/api/set", file="view", slug="rounding", path=["title"], value="", old=title).status_code == 400
    assert post(client, "/api/set", file="view", slug="rounding", path=["title"], value="X", old="stale").status_code == 409
    assert view(client, "rounding") == before


def test_optional_field_is_removed_when_cleared(client):
    old = load(view(client, "rounding"))["source"]
    assert post(client, "/api/set", file="view", slug="rounding", path=["source"], value=None, old=old).json["ok"]
    assert "source" not in load(view(client, "rounding"))


def test_append_question_and_link_it(client):
    question = str(uuid.uuid4())
    response = post(client, "/api/append", file="view", slug="cohens-kappa", path=["learning", "records"],
                    item={"kind": "question", "id": question, "text": "What does κ = 0 mean?"})
    assert response.json["ok"]
    response = post(client, "/api/append", file="view", slug="cohens-kappa", path=["learning", "answers"],
                    item={"target": {"kind": "question", "id": question}})
    assert response.json["check"]["ok"]
    entry = next(e for e in cms.catalog()["entries"] if e["slug"] == "cohens-kappa")
    assert any(r.get("text") == "What does κ = 0 mean?" for r in entry["learning"]["records"])


def test_deleting_the_last_item_removes_the_list(client):
    data = load(view(client, "rounding"))
    old = data["learning"]["answers"][0]
    assert post(client, "/api/delete", file="view", slug="rounding", path=["learning", "answers", 0], old=old).json["ok"]
    assert "answers" not in load(view(client, "rounding"))["learning"]


def test_rename_topic_everywhere(client):
    body = dict(file="view", slug="cohens-kappa", path=["learning", "records", 0, "name"], kind="topic",
                old="Cohen’s kappa", value="Cohen’s κ")
    first = post(client, "/api/rename", **body).json
    assert first["confirm"] == [{"file": "views/cohens-kappa", "count": 3}]
    assert "Cohen’s kappa" in view(client, "cohens-kappa")
    done = post(client, "/api/rename", **body, confirm=True).json
    assert done["ok"] and done["renamed"] == 3 and done["check"]["ok"]
    assert "name: Cohen’s kappa" not in view(client, "cohens-kappa")


def test_rename_topic_page_updates_links_in_views(client):
    body = dict(file="topic", slug="statistics", path=["name"], kind="topic", old="Statistics", value="Statistics and data")
    files = {item["file"] for item in post(client, "/api/rename", **body).json["confirm"]}
    assert {"topics/statistics", "views/cohens-kappa", "views/mse"} <= files
    assert post(client, "/api/rename", **body, confirm=True).json["check"]["ok"]
    assert "name: statistics}" not in view(client, "cohens-kappa")


def test_case_only_rename_touches_one_field(client):
    before = view(client, "rounding")
    body = dict(file="view", slug="rounding", path=["learning", "records", 0, "name"], kind="topic",
                old="Rounding", value="rounding")
    assert post(client, "/api/rename", **body).json["ok"]
    assert len(changed_lines(before, view(client, "rounding"))) == 2


def test_rename_fact_key(client):
    body = dict(file="view", slug="rounding", path=["learning", "records", 2, "key"], kind="fact",
                old="rounding/hundredths-digit", value="rounding/look-at-hundredths")
    assert post(client, "/api/rename", **body, confirm=True).json["renamed"] == 2
    assert "hundredths-digit" not in view(client, "rounding")


def test_dataset_credit(client, tmp_path):
    # Datasets are linked from the real repo, so point at a copied dataset folder for this edit.
    (cms.src() / "datasets").unlink()
    shutil.copytree(REPO / "src" / "datasets" / "world-countries", cms.src() / "datasets" / "world-countries",
                    ignore=shutil.ignore_patterns("files"))
    response = post(client, "/api/set", file="dataset", slug="world-countries", path=["license"],
                    value="CC0", old="Public domain")
    assert response.status_code == 200
    assert load((cms.src() / "datasets/world-countries/dataset.yml").read_text())["license"] == "CC0"


def test_requests_are_checked(client):
    assert post(client, "/api/set", file="view", slug="../x", path=["title"], value="x").status_code == 400
    assert post(client, "/api/set", file="view", slug="rounding", path=[], value="x").status_code == 400
    assert client.post("/api/set", data="file=view", content_type="application/x-www-form-urlencoded").status_code == 415
    assert client.post("/api/set", json={}, headers={"Origin": "http://evil.example"}).status_code == 403
    assert client.get("/", headers={"Host": "evil.example"}).status_code == 403


def test_every_manifest_round_trips():
    for path in [*REPO.glob("src/views/*/view.yml"), *REPO.glob("src/topics/*/topic.yml")]:
        text = path.read_text(encoding="utf8")
        doc = Document(text)
        for key, value in list(doc.data.items()):
            if not isinstance(value, (dict, list)):
                doc.set([key], value)
        assert doc.text == text, path


def test_inline_collections_reject_structural_edits():
    doc = Document("a: {b: 1, c: 2}\n")
    with pytest.raises(EditError):
        doc.delete(["a", "b"])
    doc.set(["a", "b"], "x, y")
    assert doc.text == "a: {b: 'x, y', c: 2}\n"
