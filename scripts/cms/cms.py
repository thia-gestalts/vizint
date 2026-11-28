"""Vizint content admin: an overview of every view, with inline edits written straight back to src/*.yml."""
import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request, send_file

from yamledit import Document, EditError, get, load, name_key, references, replace_scalars

REPO = Path(__file__).resolve().parents[2]
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
FILES = {"view": "views/{}/view.yml", "topic": "topics/{}/topic.yml", "dataset": "datasets/{}/dataset.yml"}
REQUIRED = {"title", "intro", "type", "frameHeight", "name", "statement", "text", "key", "id", "relation", "kind"}
RELATIONS = ("topics", "teaches", "answers", "practices", "assesses", "prerequisites")
# Record kinds a relation usually points to, for its add button.
WANTS = {"topics": ["topic"], "teaches": ["fact", "skill"], "answers": ["question"], "practices": ["skill", "fact"],
         "assesses": ["skill", "fact"], "prerequisites": ["topic", "fact", "skill", "question"]}
LABELS = {"topic": "name", "skill": "name", "fact": "statement", "question": "text"}
NUMBERS = {"order", "weight"}
BOOLEANS = {"media", "collapseExercises"}

app = Flask(__name__)
app.json.sort_keys = False  # items rendered into data-item keep their YAML key order
app.config.update(SRC=REPO / "src", SITE="http://127.0.0.1:8000", ALLOWED_HOSTS={"127.0.0.1", "localhost"})


# --- files ------------------------------------------------------------------------------------------

def src():
    return app.config["SRC"]


def yml_path(kind, slug):
    if kind not in FILES or not isinstance(slug, str) or not SLUG.fullmatch(slug):
        abort(400, "Unknown file")
    path = src() / FILES[kind].format(slug)
    if path.is_symlink() or not path.is_file():
        abort(404, "No such file")
    return path


def folders(kind):
    return sorted(p.parent.name for p in src().glob(FILES[kind].format("*")) if SLUG.fullmatch(p.parent.name))


def read_doc(kind, slug):
    return Document(yml_path(kind, slug).read_text(encoding="utf8"))


def write(path, text):
    handle, temp = tempfile.mkstemp(dir=path.parent, prefix=".cms-", suffix=".yml")
    with os.fdopen(handle, "w", encoding="utf8") as stream:
        stream.write(text)
    os.chmod(temp, path.stat().st_mode & 0o777)
    os.replace(temp, path)


def all_files():
    return [(kind, slug, yml_path(kind, slug)) for kind in ("view", "topic") for slug in folders(kind)]


# --- catalog ----------------------------------------------------------------------------------------

def catalog():
    """The resolved catalog from src/catalog.mjs, the same loader the build uses."""
    script = Path(__file__).with_name("catalog_dump.mjs")
    env = {**os.environ, "CMS_SRC": str(src())}
    try:
        result = subprocess.run(["node", str(script)], cwd=src().parent, env=env, capture_output=True, text=True,
                                timeout=60)
        return json.loads(result.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        return {"ok": False, "error": f"Could not run the catalog check: {error}"}


def check():
    result = catalog()
    return {"ok": result["ok"], "error": result.get("error")}


def blocks(learning):
    """The top-level learning block and each exercise, with their path prefixes."""
    yield ["learning"], learning
    for index, exercise in enumerate(learning.get("exercises") or []):
        yield ["learning", "exercises", index], exercise


def counts(learning):
    result = {kind: 0 for kind in LABELS}
    for _, block in blocks(learning or {}):
        for record in block.get("records") or []:
            result[record.get("kind")] = result.get(record.get("kind"), 0) + 1
    result["exercises"] = len((learning or {}).get("exercises") or [])
    return result


def identity(target):
    kind = target.get("kind")
    if kind == "topic":
        return kind, name_key(str(target.get("name", "")))
    return kind, target.get("key") if kind in ("fact", "skill") else target.get("id")


def declared(learning):
    """Every record the view declares, as targets a relation can point to."""
    options = []
    for _, block in blocks(learning or {}):
        for record in block.get("records") or []:
            kind = record.get("kind")
            field = {"topic": "name", "fact": "key", "skill": "key", "question": "id"}.get(kind)
            if field:
                options.append({"value": {"kind": kind, field: record.get(field)},
                                "label": f"{kind} · {record.get(LABELS[kind]) or record.get(field)}",
                                "identity": identity({"kind": kind, field: record.get(field)})})
    return options


def learn_url(record_id, kind="topic"):
    """The page scripts/learning-pages.mjs publishes for a record."""
    return f"{app.config['SITE']}/learn/{kind}/{hashlib.sha256(record_id.encode()).hexdigest()}/"


def topic_names(entries, pages):
    names = {p["record"]["name"] for p in pages}
    for entry in entries:
        for _, block in blocks(entry.get("learning") or {}):
            names.update(r["name"] for r in block.get("records") or [] if r.get("kind") == "topic")
    return sorted(names, key=str.casefold)


# --- security ---------------------------------------------------------------------------------------

@app.before_request
def local_only():
    host = (request.host or "").rsplit(":", 1)[0]
    if host not in app.config["ALLOWED_HOSTS"]:
        abort(403)
    if request.method == "POST":
        origin = request.headers.get("Origin")
        if origin and re.sub(r"^https?://", "", origin).rsplit(":", 1)[0] not in app.config["ALLOWED_HOSTS"]:
            abort(403)
        if not request.is_json:
            abort(415)


@app.errorhandler(400)
@app.errorhandler(404)
@app.errorhandler(409)
def json_error(error):
    if request.path.startswith("/api/"):
        return jsonify(ok=False, error=error.description), error.code
    return error


# --- pages ------------------------------------------------------------------------------------------

@app.context_processor
def globals_():
    return {"site": app.config["SITE"], "relations": RELATIONS, "labels": LABELS, "wants": WANTS, "identity": identity,
            "learn_url": learn_url}


@app.get("/")
def overview():
    result = catalog()
    resolved = {e["slug"]: e for e in result.get("entries", [])}
    views = []
    for slug in folders("view"):
        data = read_doc("view", slug).data
        entry = resolved.get(slug, {})
        learning = entry.get("learning") or data.get("learning") or {}
        topics = [r.get("name") for _, b in blocks(learning) for r in b.get("records") or [] if r.get("kind") == "topic"]
        views.append({"slug": slug, "data": data, "counts": counts(learning), "topics": topics,
                      "preview": (src() / "views" / slug / "preview.png").is_file()})
    order = {slug: index for index, slug in enumerate(resolved)}
    views.sort(key=lambda v: order.get(v["slug"], len(order)))
    return render_template("index.html", views=views, catalog=result)


@app.get("/views/<slug>")
def view_page(slug):
    doc = read_doc("view", slug)
    result = catalog()
    entry = next((e for e in result.get("entries", []) if e["slug"] == slug), None)
    generated = "learningModule" in doc.data
    learning = (entry or {}).get("learning") if generated else doc.data.get("learning") or {}
    pages = result.get("topics", [])
    extra = (src() / "views" / slug / "learning.yml")
    return render_template("view.html", slug=slug, data=doc.data, learning=learning or {}, generated=generated,
                           blocks=list(blocks(learning or {})), options=declared(learning),
                           topic_names=topic_names(result.get("entries", []), pages), catalog=result,
                           learning_yml=extra.read_text(encoding="utf8") if generated and extra.is_file() else None)


@app.get("/topics")
def topics_page():
    result = catalog()
    page_ids = {p["record"]["id"]: p["slug"] for p in result.get("topics", [])}
    slug_ids = {slug: topic_id for topic_id, slug in page_ids.items()}
    pages = [{"slug": slug, "id": slug_ids.get(slug), "data": read_doc("topic", slug).data} for slug in folders("topic")]
    used = {p["record"]["id"]: {"names": {p["record"]["name"]}, "views": set()} for p in result.get("topics", [])}
    for entry in result.get("entries", []):
        for _, block in blocks(entry.get("learning") or {}):
            for record in block.get("records") or []:
                if record.get("kind") == "topic":
                    used.setdefault(record["id"], {"names": set(), "views": set()})["names"].add(record["name"])
    # A view uses a topic when it declares it or links to it.
    for entry in result.get("entries", []):
        text = json.dumps(entry.get("learning") or {})
        for topic_id, item in used.items():
            if f'"{topic_id}"' in text:
                item["views"].add(entry["slug"])
    referenced = sorted(({"id": k, "names": sorted(v["names"]), "views": sorted(v["views"]),
                          "page": page_ids.get(k)} for k, v in used.items()),
                        key=lambda item: item["names"][0].casefold())
    return render_template("topics.html", pages=pages, referenced=referenced, catalog=result,
                           topic_names=topic_names(result.get("entries", []), result.get("topics", [])))


@app.get("/datasets")
def datasets_page():
    items = [{"slug": slug, "data": read_doc("dataset", slug).data} for slug in folders("dataset")]
    return render_template("datasets.html", datasets=items, catalog=check())


@app.get("/preview/<slug>.png")
def preview(slug):
    if not SLUG.fullmatch(slug):
        abort(404)
    path = src() / "views" / slug / "preview.png"
    if not path.is_file() or path.is_symlink():
        abort(404)
    return send_file(path, max_age=0)


# --- api --------------------------------------------------------------------------------------------

def coerce(path, value):
    field = path[-1] if path else None
    if value == "" or value == []:
        value = None
    if value is None:
        if field in REQUIRED:
            abort(400, f"{field} cannot be empty")
        return None
    if field in NUMBERS:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            abort(400, f"{field} must be a number")
        return int(value) if float(value).is_integer() else value
    if field in BOOLEANS and not isinstance(value, bool):
        abort(400, f"{field} must be true or false")
    if isinstance(value, str):
        value = value.strip()
        if not value and field in REQUIRED:
            abort(400, f"{field} cannot be empty")
    return value


def body():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        abort(400, "Expected a JSON object")
    path = payload.get("path")
    if not isinstance(path, list) or not path or not all(isinstance(s, (str, int)) and not isinstance(s, bool)
                                                         for s in path):
        abort(400, "Invalid path")
    return payload, path


def apply(kind, slug, edit):
    file = yml_path(kind, slug)
    doc = Document(file.read_text(encoding="utf8"))
    try:
        edit(doc)
    except EditError as error:
        abort(400, str(error))
    write(file, doc.text)
    return jsonify(ok=True, check=check())


def expect(doc, path, old):
    if get(doc.data, path) != old:
        abort(409, "The file changed since this page loaded. Reload to see the current version.")


@app.post("/api/set")
def api_set():
    payload, path = body()
    value = coerce(path, payload.get("value"))

    def edit(doc):
        expect(doc, path, payload.get("old"))
        doc.set(path, value)
    return apply(payload.get("file"), payload.get("slug"), edit)


@app.post("/api/append")
def api_append():
    payload, path = body()
    item = payload.get("item")
    if item is None:
        abort(400, "Missing item")

    def edit(doc):
        doc.append(path, item)
    return apply(payload.get("file"), payload.get("slug"), edit)


@app.post("/api/delete")
def api_delete():
    payload, path = body()

    def edit(doc):
        expect(doc, path, payload.get("old"))
        doc.delete(path)
    return apply(payload.get("file"), payload.get("slug"), edit)


@app.post("/api/rename")
def api_rename():
    """Rename a topic, fact or skill and every reference to it across views and topic pages."""
    payload, path = body()
    kind, old, new = payload.get("kind"), payload.get("old"), coerce(path, payload.get("value"))
    if kind not in ("topic", "fact", "skill") or not isinstance(old, str) or not isinstance(new, str):
        abort(400, "Invalid rename")
    field = "name" if kind == "topic" else "key"
    file = yml_path(payload.get("file"), payload.get("slug"))
    doc = Document(file.read_text(encoding="utf8"))
    expect(doc, path, old)
    same = name_key(old) == name_key(new) if kind == "topic" else old == new
    if same:
        try:
            doc.set(path, new)
        except EditError as error:
            abort(400, str(error))
        write(file, doc.text)
        return jsonify(ok=True, check=check())

    match = (lambda v: name_key(v) == name_key(old)) if kind == "topic" else (lambda v: v == old)
    changes = []
    for file_kind, slug, other in all_files():
        text = other.read_text(encoding="utf8")
        nodes, root = references(text, {kind}, field, match)
        if file_kind == "topic" and kind == "topic":
            # A topic page names its topic at the top level, without `kind: topic`.
            nodes += [(v, False) for k, v in root.value if k.value == "name" and match(v.value)]
        if nodes:
            changes.append((other, text, nodes, f"{file_kind}s/{slug}", len(nodes)))
    total = sum(item[4] for item in changes)
    if total > 1 and not payload.get("confirm"):
        return jsonify(ok=False, confirm=[{"file": label, "count": count} for *_, label, count in changes])
    for other, text, nodes, label, _ in changes:
        updated = replace_scalars(text, nodes, new)
        if load(updated) is None:
            abort(400, f"Rename would break {label}")
        write(other, updated)
    return jsonify(ok=True, renamed=total, check=check())


@app.post("/api/check")
def api_check():
    result = subprocess.run(["npm", "run", "--silent", "check:views"], cwd=REPO, capture_output=True, text=True,
                            timeout=600)
    return jsonify(ok=result.returncode == 0, output=(result.stdout + result.stderr).strip() or "No output.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--site", default=os.environ.get("VIZINT_SITE", "http://127.0.0.1:8000"),
                        help="where the built site is served, for view links")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()
    app.config["SITE"] = args.site.rstrip("/")
    print(f"Vizint CMS  http://127.0.0.1:{args.port}")
    app.run(host="127.0.0.1", port=args.port, debug=args.debug)


if __name__ == "__main__":
    main()
