from __future__ import annotations

from typing import Any, Dict, FrozenSet


DATASET_TYPE_ALIASES: Dict[str, FrozenSet[str]] = {
    "v2x_traj": frozenset({"v2x-traj", "v2x_traj", "v2xtraj"}),
    "v2x_seq": frozenset({"v2x-seq", "v2x_seq", "v2xseq"}),
    "ind": frozenset({"ind", "in-d", "ind_dataset"}),
    "sind": frozenset({"sind", "sin-d", "sin_d", "sind_dataset"}),
    "consider_it_cpm": frozenset({"consider-it-cpm", "consider_it_cpm", "cpm", "cpm-objects", "considerit"}),
}

DATASET_TYPE_TO_FAMILY: Dict[str, str] = {
    "v2x_traj": "v2x-traj",
    "v2x_seq": "v2x-seq",
    "ind": "ind",
    "sind": "sind",
    "consider_it_cpm": "cpm-objects",
}

SUPPORTED_DATASET_TYPES: FrozenSet[str] = frozenset(DATASET_TYPE_TO_FAMILY.keys())
SUPPORTED_DATASET_FAMILIES: FrozenSet[str] = frozenset(DATASET_TYPE_TO_FAMILY.values())

_ALIAS_TO_TYPE: Dict[str, str] = {alias: t for t, aliases in DATASET_TYPE_ALIASES.items() for alias in aliases}
_FAMILY_TO_TYPE: Dict[str, str] = {family: t for t, family in DATASET_TYPE_TO_FAMILY.items()}


def normalize_dataset_type(raw: Any) -> str:
    s = str(raw or "").strip().lower()
    return _ALIAS_TO_TYPE.get(s, "")


def dataset_family_from_type(raw: Any) -> str:
    t = normalize_dataset_type(raw)
    return DATASET_TYPE_TO_FAMILY.get(t, "")


def dataset_type_from_family(raw: Any) -> str:
    fam = str(raw or "").strip().lower()
    return _FAMILY_TO_TYPE.get(fam, "")


def is_supported_family(raw: Any) -> bool:
    return dataset_type_from_family(raw) in SUPPORTED_DATASET_TYPES
