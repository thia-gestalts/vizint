"""Surgical edits to hand-written YAML.

Re-dumping a whole document reflows every wrapped line, so edits here locate the target node by its
marks and rewrite only that span of text. After each edit the result is parsed again and compared with
the intended data, so an edit either does exactly what was asked or raises EditError.
"""
import copy
import io
import re

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq
from ruamel.yaml.nodes import MappingNode, ScalarNode, SequenceNode

WIDTH = 80


class EditError(ValueError):
    pass


def _yaml():
    yaml = YAML()
    yaml.preserve_quotes = True
    yaml.indent(mapping=2, sequence=4, offset=2)
    return yaml


def load(text):
    """Plain Python data (dicts, lists, scalars) for comparisons and templates."""
    return _plain(YAML(typ="safe", pure=True).load(text))


def _plain(value):
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value


def get(data, path, default=None):
    for segment in path:
        try:
            data = data[segment]
        except (KeyError, IndexError, TypeError):
            return default
    return data


def _set_in(data, path, value):
    target = data
    for segment in path[:-1]:
        if isinstance(target, dict) and segment not in target:
            target[segment] = {}
        target = target[segment]
    if value is None:
        del target[path[-1]]
    elif isinstance(target, list) and path[-1] == len(target):
        target.append(value)
    else:
        target[path[-1]] = value


# --- node navigation -------------------------------------------------------------------------------

def _child(node, segment):
    """Return (key_node, value_node) for a mapping key or (None, item) for a sequence index."""
    if isinstance(node, MappingNode) and isinstance(segment, str):
        for key, value in node.value:
            if isinstance(key, ScalarNode) and key.value == segment:
                return key, value
    if isinstance(node, SequenceNode) and isinstance(segment, int) and 0 <= segment < len(node.value):
        return None, node.value[segment]
    return None


def _locate(root, path):
    """[(parent, key_node, node)] for every step that exists; stops at the first missing segment."""
    steps, node = [], root
    for segment in path:
        found = _child(node, segment) if node is not None else None
        if found is None:
            break
        steps.append((node, *found))
        node = found[1]
    return steps


def _content_end(node):
    """Index just past the last character that belongs to node (ignores trailing blank lines and comments)."""
    if isinstance(node, ScalarNode) or node.flow_style:
        return node.end_mark.index
    children = [v for pair in node.value for v in pair] if isinstance(node, MappingNode) else node.value
    return max((_content_end(child) for child in children), default=node.end_mark.index)


def _line_start(text, index):
    return text.rfind("\n", 0, index) + 1


def _next_line(text, index):
    end = text.find("\n", index)
    return len(text) if end < 0 else end + 1


# --- rendering ------------------------------------------------------------------------------------

def _rt(value, flow=False):
    """Convert plain data to ruamel containers: scalar lists stay inline, like `patterns: [a, b]`."""
    if isinstance(value, dict):
        result = CommentedMap((k, _rt(v, flow)) for k, v in value.items())
        if flow:
            result.fa.set_flow_style()
        return result
    if isinstance(value, list):
        result = CommentedSeq(_rt(v, flow) for v in value)
        if flow or all(not isinstance(v, (dict, list)) for v in value):
            result.fa.set_flow_style()
        return result
    return value


def _dump(value, width):
    yaml = _yaml()
    yaml.width = max(width, 30)
    buffer = io.StringIO()
    yaml.dump(value, buffer)
    return "\n".join(line.rstrip() for line in buffer.getvalue().rstrip("\n").split("\n"))


def _indent_rest(block, column):
    first, *rest = block.split("\n")
    return "\n".join([first, *(" " * column + line if line else line for line in rest)])


def render_pair(key, value, column, flow=False):
    """`key: value` as it should appear at column, continuation lines included."""
    return _indent_rest(_dump(CommentedMap([(key, _rt(value, flow))]), WIDTH - column), column)


def render_item(value, column):
    """A block sequence item, `- ...`, with its dash at column."""
    yaml_text = _dump(CommentedSeq([_rt(value)]), WIDTH - column)
    # ruamel indents the top-level sequence by its offset; normalise to the dash at column 0.
    lines = yaml_text.split("\n")
    strip = len(lines[0]) - len(lines[0].lstrip())
    return "\n".join(" " * column + line[strip:] if line else line for line in lines)


def render_flow_scalar(value):
    """A scalar that is safe inside `{...}` or `[...]`."""
    seq = CommentedSeq([value])
    seq.fa.set_flow_style()
    text = _dump(seq, 10_000)
    return text[1:-1]


# --- document ------------------------------------------------------------------------------------

class Document:
    def __init__(self, text):
        self.text = text
        self.data = load(text)

    def _root(self):
        return _yaml().compose(self.text)

    def _commit(self, text, expected):
        try:
            actual = load(text)
        except Exception as error:  # noqa: BLE001 - any parse failure means the splice went wrong
            raise EditError(f"Edit would produce invalid YAML: {error}") from error
        if actual != expected:
            raise EditError("Edit would change more than the requested field")
        self.text, self.data = text, actual

    def set(self, path, value):
        """Set a field; None deletes it. Missing mappings on the way are created."""
        if value is None:
            return self.delete(path)
        expected = copy.deepcopy(self.data)
        _set_in(expected, path, value)
        if expected == self.data:
            return
        root = self._root()
        steps = _locate(root, path)
        if len(steps) == len(path):
            parent, key, node = steps[-1]
            if parent.flow_style:
                if isinstance(value, (dict, list)):
                    raise EditError("Cannot replace a collection inside an inline collection")
                text = self.text[:node.start_mark.index] + render_flow_scalar(value) + self.text[node.end_mark.index:]
            elif key is not None:
                rendered = render_pair(path[-1], value, key.start_mark.column,
                                       flow=isinstance(node, MappingNode) and bool(node.flow_style))
                text = self.text[:key.start_mark.index] + rendered + self.text[_content_end(node):]
            else:
                raise EditError("Replace sequence items with delete and append")
        else:
            text = self._insert(root, steps, path, value)
        self._commit(text, expected)

    def _insert(self, root, steps, path, value):
        depth = len(steps)
        parent = steps[-1][2] if steps else root
        if not isinstance(parent, MappingNode) or not isinstance(path[depth], str):
            raise EditError(f"Cannot create {path[depth]!r} here")
        if parent.flow_style:
            raise EditError("Cannot add a key to an inline mapping")
        for segment in reversed(path[depth + 1:]):
            value = {segment: value}
        key = path[depth]
        if not parent.value:
            raise EditError("Cannot add to an empty mapping")
        column = parent.value[0][0].start_mark.column
        before = None
        if parent is root and key != "learning":
            before = next((k for k, _ in parent.value if k.value == "learning"), None)
        if before is not None:
            offset = _line_start(self.text, before.start_mark.index)
        else:
            offset = _next_line(self.text, _content_end(parent))
        block = " " * column + render_pair(key, value, column) + "\n"
        prefix = self.text[:offset]
        if prefix and not prefix.endswith("\n"):
            prefix += "\n"
        return prefix + block + self.text[offset:]

    def append(self, path, item):
        """Append an item to a sequence, creating the sequence if needed."""
        current = get(self.data, path)
        if current is None:
            return self.set(path, [item])
        if not isinstance(current, list):
            raise EditError("Not a list")
        expected = copy.deepcopy(self.data)
        get(expected, path).append(item)
        node = _locate(self._root(), path)[-1][2]
        if node.flow_style or not node.value:
            return self.set(path, current + [item])
        first = node.value[0]
        column = _line_start_column(self.text, first)
        offset = _next_line(self.text, _content_end(node))
        prefix = self.text[:offset]
        if not prefix.endswith("\n"):
            prefix += "\n"
        self._commit(prefix + render_item(item, column) + "\n" + self.text[offset:], expected)

    def delete(self, path):
        """Delete a key or sequence item. A collection left empty is removed with it."""
        if get(self.data, path) is None and not _exists(self.data, path):
            return
        parent_value = get(self.data, path[:-1])
        if path[:-1] and len(parent_value) == 1:
            return self.delete(path[:-1])
        expected = copy.deepcopy(self.data)
        _set_in(expected, path, None) if isinstance(parent_value, dict) else get(expected, path[:-1]).pop(path[-1])
        parent, key, node = _locate(self._root(), path)[-1]
        if parent.flow_style:
            if isinstance(parent_value, dict):
                raise EditError("Cannot delete a key from an inline mapping")
            items = [v for i, v in enumerate(parent_value) if i != path[-1]]
            return self.set(path[:-1], items)
        start = key.start_mark.index if key is not None else node.start_mark.index
        start = _line_start(self.text, start)
        end = _next_line(self.text, _content_end(node))
        self._commit(self.text[:start] + self.text[end:], expected)


def _exists(data, path):
    marker = object()
    return get(data, path, marker) is not marker


def _line_start_column(text, item):
    """Column of the dash in front of a block sequence item."""
    dash = text.rfind("-", 0, item.start_mark.index)
    return dash - _line_start(text, dash)


# --- references ----------------------------------------------------------------------------------

_space = re.compile(r"[\t-\r \x85\xa0  -     　]+")


def name_key(name):
    """Same identity as nameId in src/name-id.mjs: NFC, collapsed white space, full case folding."""
    import unicodedata
    normalized = _space.sub(" ", unicodedata.normalize("NFC", name)).strip(" ")
    return unicodedata.normalize("NFC", normalized.casefold())


def references(text, kind, field, match):
    """Scalar nodes for `field` in every mapping with `kind: <kind>` whose value satisfies match."""
    found = []

    def walk(node, parent_flow=False):
        if isinstance(node, MappingNode):
            pairs = {k.value: v for k, v in node.value if isinstance(k, ScalarNode)}
            target = pairs.get(field)
            kind_node = pairs.get("kind")
            if (isinstance(kind_node, ScalarNode) and kind_node.value in kind and isinstance(target, ScalarNode)
                    and match(target.value)):
                found.append((target, bool(node.flow_style)))
            for _, value in node.value:
                walk(value)
        elif isinstance(node, SequenceNode):
            for item in node.value:
                walk(item)

    root = _yaml().compose(text)
    if root is not None:
        walk(root)
    return found, root


def replace_scalars(text, nodes, value):
    """Replace each (node, flow) scalar with value, keeping everything else."""
    for node, flow in sorted(nodes, key=lambda pair: -pair[0].start_mark.index):
        rendered = render_flow_scalar(value) if flow else _dump(CommentedMap([("k", value)]), 10_000)[3:]
        text = text[:node.start_mark.index] + rendered + text[node.end_mark.index:]
    return text
