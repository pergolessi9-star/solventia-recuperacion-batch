"""Prueba privada de recuperación batch. Ejecutar con Python 3."""
import hashlib
import json
import sqlite3
import tempfile
from pathlib import Path
from time import perf_counter_ns


def encode(value):
    return json.dumps(value, sort_keys=True, allow_nan=False).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate(rows):
    if not all(type(group) is int and type(amount) is int for group, amount in rows):
        raise ValueError("Registro inválido")
    return rows


def calculate(rows):
    totals = {}
    for group, amount in rows:
        totals[group] = totals.get(group, 0) + amount
    return totals


def render(totals):
    return "grupo,total\n" + "".join(
        f"{group},{totals[group]}\n" for group in sorted(totals, key=int))


STAGES = (validate, calculate, render)


def execute(db, rows, reuse=True, fail=False):
    started = perf_counter_ns()
    trace = []
    payload = encode(rows)
    version = digest(Path(__file__).read_bytes())
    for stage in STAGES:
        name = stage.__name__
        key = digest(payload)
        cached = db.execute(
            "SELECT output,hash FROM stages WHERE stage=? AND input=? AND version=?",
            (name, key, version)).fetchone() if reuse else None
        if cached and digest(cached[0]) == cached[1]:
            payload = cached[0]
            trace.append([name, "reutilizada"])
            continue
        if fail and stage is render:
            trace.append([name, "fallo controlado"])
            return None, trace, perf_counter_ns() - started
        payload = encode(stage(json.loads(payload)))
        with db:
            db.execute("INSERT OR REPLACE INTO stages VALUES(?,?,?,?,?)",
                       (name, key, version, payload, digest(payload)))
        trace.append([name, "ejecutada"])
    return json.loads(payload).encode(), trace, perf_counter_ns() - started


def verify(db, rows, changed=False):
    output, trace, elapsed = execute(db, rows)
    baseline, reference, baseline_time = execute(db, rows, reuse=False)
    assert output == baseline and output is not None
    assert [action for _, action in trace] == (
        ["ejecutada"] * 3 if changed else ["reutilizada", "reutilizada", "ejecutada"])
    return {"traza": trace, "referencia": reference,
            "tiempo_selectivo_ns": elapsed, "tiempo_referencia_ns": baseline_time,
            "sha256_csv": digest(output), "identico_byte_a_byte": True}


def main():
    rows = [(i % 64, i % 997) for i in range(200000)]
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "checkpoint.sqlite"
        with sqlite3.connect(path) as db:
            db.execute("CREATE TABLE stages(stage,input,version,output,hash,"
                       "PRIMARY KEY(stage,input,version))")
            output, failure, detection = execute(db, rows, fail=True)
            assert output is None
        db.close()
        with sqlite3.connect(path) as db:
            recovery = verify(db, rows)
            with db:
                db.execute("DELETE FROM stages WHERE stage='render'")
            updated = [(0, 1), *rows[1:]]
            invalidation = verify(db, updated, changed=True)
            assert recovery["sha256_csv"] != invalidation["sha256_csv"]
        db.close()
    print(json.dumps({"registros_sinteticos": len(rows), "fallo": failure,
                      "tiempo_desde_inicio_hasta_fallo_ns": detection,
                      "recuperacion": recovery, "entrada_modificada": invalidation,
                      "energia": "sin medicion fisica"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
