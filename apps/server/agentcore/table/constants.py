"""Closed sets for the creation-tool 多维表格."""

ROW_LIMIT = 5000
COLUMN_IMPORT_MAX = 48
CSV_IMPORT_MAX_BYTES = 8 * 1024 * 1024
SELECTION_MAX = 40
TITLE_MAX = 500
TABLE_UNBOUND = "当前没有绑定表格。请 @ 已导入的 csv。"
VIEW_NAME_MAX = 200
LABEL_MAX = 80
OPTION_MAX = 50
CELL_TEXT_MAX = 8000
READ_ROW_CAP = 200

FIELD_TYPES = (
    "text",
    "number",
    "singleSelect",
    "multiSelect",
    "date",
    "datetime",
    "checkbox",
    "url",
)

DISPLAY_MODES = ("table", "kanban", "calendar", "gallery")
DENSITIES = ("compact", "comfortable", "loose")
COLUMN_WIDTH_MIN = 80
COLUMN_WIDTH_MAX = 480
OPTION_TONES = ("gray", "blue", "green", "orange", "red")

FILTER_OPS = (
    "contains",
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "empty",
    "not_empty",
    "any_of",
)

OP_KINDS = (
    "add_column",
    "update_column",
    "remove_column",
    "upsert_rows",
    "update_cells",
    "delete_rows",
    "set_view",
    "save_view",
    "switch_view",
    "delete_view",
    "undo_batch",
)

STRUCT_OPS = frozenset({"add_column", "update_column", "remove_column"})
VIEW_OPS = frozenset({"set_view", "save_view", "switch_view", "delete_view"})
DATA_OPS = frozenset({"upsert_rows", "update_cells", "delete_rows"})
UNDO_OPS = frozenset({"undo_batch"})
