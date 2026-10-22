#!/usr/bin/env bash
# One row per warehouse table: its name, rows and columns, read from the parquet files.
#
# A loader that needs a table reads its partitions with a glob that starts at the first
# partition folder, so files the producer keeps beside the data are skipped:
#   read_parquet('$DATA/parquet/<table>/*=*/**/*.parquet', hive_partitioning=true, union_by_name=true)
set -euo pipefail
W="${DATA:?run with observatory dev or observatory build, which set DATA}/parquet"
sql="SELECT NULL::VARCHAR AS table_name, NULL::BIGINT AS rows, NULL::BIGINT AS columns WHERE false"
for d in "$W"/*/; do
  t=$(basename "$d")
  [[ "$t" =~ ^[A-Za-z0-9_]+$ ]] || continue
  compgen -G "$d*=*" >/dev/null || continue
  src="read_parquet('$d*=*/**/*.parquet', hive_partitioning=true, union_by_name=true)"
  sql="$sql UNION ALL SELECT '$t', (SELECT count(*) FROM $src), (SELECT count(*) FROM (DESCRIBE SELECT * FROM $src))"
done
DUCKDB_AGENT_MODE=0 duckdb -c "COPY ($sql ORDER BY 1) TO '/dev/stdout' (FORMAT parquet)"
