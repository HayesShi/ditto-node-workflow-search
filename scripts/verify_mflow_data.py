"""Verify Ditto input files against pinned MFlow splits; no model calls or writes."""
import argparse
import hashlib
import json
from pathlib import Path


def verify(data_dir, dataset, lock):
    checked = {}
    for role, spec in lock["datasets"][dataset]["splits"].items():
        path = data_dir / spec["file"]
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != spec["sha256"]:
            raise ValueError(f"MFlow {dataset}/{role}: file content/order differs: {path}")
        rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
        if len(rows) != spec["count"]:
            raise ValueError(f"MFlow {dataset}/{role}: unexpected count: {path}")
        checked[role] = len(rows)
    return {"dataset": dataset, "protocol": lock["datasets"][dataset]["protocol"], "verified": checked}


def main():
    lock = json.loads((Path(__file__).resolve().parents[1] / "configs/mflow-data-lock.json").read_text(encoding="utf-8"))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, choices=["all-aflow", *lock["datasets"]])
    parser.add_argument("--data-dir", required=True, type=Path)
    args = parser.parse_args()
    datasets = [name for name in lock["datasets"] if name != "automationbench"] if args.dataset == "all-aflow" else [args.dataset]
    # Verify both partitions before reporting success. SHA-256 fixes membership,
    # order and all fields, not just the number of records.
    results = [verify(args.data_dir, name, lock) for name in datasets]
    print(json.dumps({"reference": lock["reference"], "results": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
