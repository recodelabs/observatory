#!/usr/bin/env bash
# A small warehouse in the layout Observatory reads: one table, places, partitioned by country,
# and a manifest. Made-up data.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf warehouse && mkdir -p warehouse/parquet
DUCKDB_AGENT_MODE=0 duckdb -c "
COPY (
  SELECT * FROM (VALUES
    ('KE', 'ke-01', 'Mombasa', 1, 1208333),
    ('KE', 'ke-02', 'Kwale', 1, 866820),
    ('KE', 'ke-03', 'Kilifi', 1, 1453787),
    ('TZ', 'tz-01', 'Arusha', 1, 2356255),
    ('TZ', 'tz-02', 'Dodoma', 1, 3085625)
  ) AS t(country, id, name, admin_level, population)
) TO 'warehouse/parquet/places' (FORMAT parquet, PARTITION_BY (country));"
cat > warehouse/manifest.json <<JSON
{"refreshed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "tables": {"places": {"rows": 5}}}
JSON
echo "warehouse/: places (5 rows)"
