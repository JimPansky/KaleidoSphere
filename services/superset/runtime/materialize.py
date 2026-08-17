import hashlib
import json
import os
import sqlite3
from pathlib import Path

from superset.app import create_app

SUMMARY_DATASET_UUID = "b1000000-0000-4000-8000-000000000001"
DETAIL_DATASET_UUID = "b1000000-0000-4000-8000-000000000002"
DASHBOARD_UUID = "b1000000-0000-4000-8000-000000000003"
TECH_DATASET_UUIDS = {
    "technical_system_schema_overview": "b1000000-0000-4000-8000-000000000011",
    "technical_tables_capacity": "b1000000-0000-4000-8000-000000000012",
    "technical_code_dependencies": "b1000000-0000-4000-8000-000000000013",
    "technical_coverage_blind_spots": "b1000000-0000-4000-8000-000000000014",
}
TECH_DASHBOARD_UUIDS = {
    "KaleidoSphere Technical System & Schema Overview": "b1000000-0000-4000-8000-000000000021",
    "KaleidoSphere Technical Tables, Freshness & Capacity": "b1000000-0000-4000-8000-000000000022",
    "KaleidoSphere Technical Code, Validity & Dependencies": "b1000000-0000-4000-8000-000000000023",
    "KaleidoSphere Technical Coverage, Errors & Blind Spots": "b1000000-0000-4000-8000-000000000024",
}
PROJECTION = Path("/var/lib/chimpmaera-bi/projection/analytics.db")
APP = create_app()

def fail(code):
    raise RuntimeError(code)

def exact(value, keys):
    if not isinstance(value, dict) or sorted(value) != sorted(keys):
        fail("SUPERSET_MATERIALIZE_REQUEST_DENIED")

def source_readback(request):
    exact(request, ["receiptId", "snapshotSha256", "projectionSha256"])
    if not isinstance(request["receiptId"], str) or not request["receiptId"].startswith(("mssql-", "oracle-")):
        fail("SUPERSET_RECEIPT_ID_DENIED")
    for key in ("snapshotSha256", "projectionSha256"):
        value = request[key]
        if not isinstance(value, str) or len(value) != 64 or any(ch not in "0123456789abcdef" for ch in value):
            fail("SUPERSET_DIGEST_DENIED")
    if hashlib.sha256(PROJECTION.read_bytes()).hexdigest() != request["projectionSha256"]:
        fail("SUPERSET_PROJECTION_DIGEST_MISMATCH")
    connection = sqlite3.connect(f"file:{PROJECTION}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        summary = connection.execute("SELECT * FROM bi_analysis_summary WHERE receipt_id=?", (request["receiptId"],)).fetchone()
        detail_count = connection.execute("SELECT COUNT(*) count FROM bi_analysis_detail WHERE receipt_id=?", (request["receiptId"],)).fetchone()["count"]
        technical_counts = {table: connection.execute(f"SELECT COUNT(*) count FROM {table} WHERE receipt_id=?", (request["receiptId"],)).fetchone()["count"]
                            for table in TECH_DATASET_UUIDS}
    finally:
        connection.close()
    if not summary or summary["snapshot_sha256"] != request["snapshotSha256"] or summary["source_read_only"] != 1:
        fail("SUPERSET_PROJECTION_BINDING_MISMATCH")
    if any(count is None for count in technical_counts.values()):
        fail("SUPERSET_TECHNICAL_PROJECTION_MISSING")
    return dict(summary), detail_count, technical_counts

def remove_legacy_permission(sm, view_menu_name):
    legacy = sm.find_permission_view_menu("datasource access", view_menu_name)
    if not legacy:
        return
    for role in db.session.query(sm.role_model).all():
        if legacy in role.permissions:
            role.permissions.remove(legacy)
    db.session.flush()
    db.session.delete(legacy)
    db.session.flush()

def dataset_permission(sm, role, dataset):
    permission = sm.add_permission_view_menu("datasource_access", dataset.perm)
    remove_legacy_permission(sm, dataset.perm)
    if permission and permission not in role.permissions:
        sm.add_permission_role(role, permission)

def materialize(request):
    summary, detail_count, technical_counts = source_readback(request)
    with APP.app_context():
        global db
        from superset import db
        from superset.connectors.sqla.models import SqlaTable, SqlMetric, TableColumn
        from superset.models.core import Database
        from superset.models.dashboard import Dashboard
        from superset.models.slice import Slice

        sm = APP.appbuilder.sm
        analyst_role = sm.find_role("ChimpMaera BI Analyst")
        if not analyst_role:
            fail("SUPERSET_ANALYST_ROLE_MISSING")
        database = db.session.query(Database).filter_by(database_name="ChimpMaera BI managed projection").one_or_none()
        if not database or database.allow_dml or database.expose_in_sqllab:
            fail("SUPERSET_DATABASE_BOUNDARY_INVALID")

        summary_dataset = db.session.query(SqlaTable).filter_by(uuid=SUMMARY_DATASET_UUID).one_or_none()
        if not summary_dataset:
            summary_dataset = SqlaTable(uuid=SUMMARY_DATASET_UUID, table_name="bi_analysis_summary", database=database, is_sqllab_view=False)
            db.session.add(summary_dataset)
            db.session.flush()
        summary_dataset.description = f"Managed read-only {summary['source_engine']} analysis receipt {request['receiptId']} · source mode {summary['source_mode']} · snapshot {request['snapshotSha256']}"
        if not summary_dataset.columns:
            summary_dataset.columns = [TableColumn(column_name=name, type=column_type, filterable=name in {"source_engine", "source_database", "source_mode", "status"}, groupby=name in {"source_engine", "source_database", "source_mode", "status"}) for name, column_type in [
                ("receipt_id","TEXT"),("source_engine","TEXT"),("source_database","TEXT"),("source_mode","TEXT"),("runtime_validation","TEXT"),("status","TEXT"),("analyzed_at","TEXT"),("relation_count","INTEGER"),("column_count","INTEGER"),("constraint_count","INTEGER"),("index_count","INTEGER"),("snapshot_sha256","TEXT"),("source_read_only","INTEGER")]]
        metric_specs = [
            ("bi_relation_count", "SUM(relation_count)", "Relations"),
            ("bi_column_count", "SUM(column_count)", "Columns"),
            ("bi_constraint_count", "SUM(constraint_count)", "Constraints"),
            ("bi_index_count", "SUM(index_count)", "Indexes"),
        ]
        existing_metrics = {metric.metric_name: metric for metric in summary_dataset.metrics}
        for metric_name, expression, label in metric_specs:
            metric = existing_metrics.get(metric_name)
            if not metric:
                metric = SqlMetric(metric_name=metric_name, expression=expression, verbose_name=label, description="Bound to managed read-only analysis projection")
                summary_dataset.metrics.append(metric)
            metric.expression = expression
            metric.verbose_name = label

        detail_dataset = db.session.query(SqlaTable).filter_by(uuid=DETAIL_DATASET_UUID).one_or_none()
        if not detail_dataset:
            detail_dataset = SqlaTable(uuid=DETAIL_DATASET_UUID, table_name="bi_analysis_detail", database=database, is_sqllab_view=False)
            db.session.add(detail_dataset)
            db.session.flush()
        detail_dataset.description = f"Column-level drill view for governed receipt {request['receiptId']}; no source row samples or credentials."
        if not detail_dataset.columns:
            detail_dataset.columns = [TableColumn(column_name=name, type=column_type, filterable=name in {"schema_name", "relation_name", "relation_kind", "data_type", "is_nullable"}, groupby=name in {"schema_name", "relation_name", "relation_kind", "data_type", "is_nullable"}) for name, column_type in [
                ("row_id","TEXT"),("receipt_id","TEXT"),("schema_name","TEXT"),("relation_name","TEXT"),("relation_kind","TEXT"),("column_name","TEXT"),("data_type","TEXT"),("ordinal_position","INTEGER"),("is_nullable","INTEGER")]]
        db.session.flush()
        dataset_permission(sm, analyst_role, summary_dataset)
        dataset_permission(sm, analyst_role, detail_dataset)

        def managed_dataset(table_name, uuid, columns):
            dataset = db.session.query(SqlaTable).filter_by(uuid=uuid).one_or_none()
            if not dataset:
                dataset = SqlaTable(uuid=uuid, table_name=table_name, database=database, is_sqllab_view=False)
                db.session.add(dataset)
                db.session.flush()
            dataset.table_name = table_name
            dataset.database = database
            dataset.is_sqllab_view = False
            dataset.description = f"M3 fixed technical overview table {table_name}; catalog/projection data only, receipt {request['receiptId']}."
            existing = {column.column_name: column for column in dataset.columns}
            for name, column_type, filterable, groupby in columns:
                column = existing.get(name)
                if not column:
                    column = TableColumn(column_name=name)
                    dataset.columns.append(column)
                column.type = column_type
                column.filterable = filterable
                column.groupby = groupby
            dataset_permission(sm, analyst_role, dataset)
            return dataset

        tech_datasets = {
            "system": managed_dataset("technical_system_schema_overview", TECH_DATASET_UUIDS["technical_system_schema_overview"], [
                ("row_id","TEXT",False,False),("receipt_id","TEXT",True,True),("snapshot_sha256","TEXT",True,True),("engine","TEXT",True,True),("database_name","TEXT",True,True),("schema_name","TEXT",True,True),("source_mode","TEXT",True,True),("runtime_validation","TEXT",True,True),("relation_count","INTEGER",False,False),("column_count","INTEGER",False,False),("stored_object_count","INTEGER",False,False),("invalid_object_count","INTEGER",False,False),("compile_issue_count","INTEGER",False,False),("denied_or_unknown_collectors","INTEGER",False,False),("coverage_all_complete","INTEGER",True,True)]),
            "tables": managed_dataset("technical_tables_capacity", TECH_DATASET_UUIDS["technical_tables_capacity"], [
                ("row_id","TEXT",False,False),("receipt_id","TEXT",True,True),("snapshot_sha256","TEXT",True,True),("schema_name","TEXT",True,True),("relation_name","TEXT",True,True),("relation_kind","TEXT",True,True),("column_count","INTEGER",False,False),("constraint_count","INTEGER",False,False),("index_count","INTEGER",False,False),("num_rows_estimate","FLOAT",False,False),("last_analyzed","TEXT",True,True),("stale_stats","TEXT",True,True),("bytes","FLOAT",False,False),("blocks","FLOAT",False,False),("size_semantics","TEXT",True,True),("row_count_semantics","TEXT",True,True)]),
            "code": managed_dataset("technical_code_dependencies", TECH_DATASET_UUIDS["technical_code_dependencies"], [
                ("row_id","TEXT",False,False),("receipt_id","TEXT",True,True),("snapshot_sha256","TEXT",True,True),("schema_name","TEXT",True,True),("object_name","TEXT",True,True),("object_kind","TEXT",True,True),("status","TEXT",True,True),("signature_count","INTEGER",False,False),("compile_issue_count","INTEGER",False,False),("depends_on_count","INTEGER",False,False),("used_by_count","INTEGER",False,False),("source_line_count","INTEGER",False,False),("source_hash_sha256","TEXT",False,False),("wrapped_code_blind_spot","TEXT",True,True)]),
            "coverage": managed_dataset("technical_coverage_blind_spots", TECH_DATASET_UUIDS["technical_coverage_blind_spots"], [
                ("row_id","TEXT",False,False),("receipt_id","TEXT",True,True),("snapshot_sha256","TEXT",True,True),("query_id","TEXT",True,True),("category","TEXT",True,True),("state","TEXT",True,True),("visibility","TEXT",True,True),("reason_code","TEXT",True,True),("row_count","INTEGER",False,False),("empty_interpretation","TEXT",True,True),("caveat","TEXT",True,True)]),
        }

        charts = []
        for title, viz, dataset, params in [
            ("BI relations", "big_number_total", summary_dataset, {"metric":"bi_relation_count","subheader":"read-only catalog relations"}),
            ("BI columns", "big_number_total", summary_dataset, {"metric":"bi_column_count","subheader":"read-only catalog columns"}),
            ("BI constraints", "big_number_total", summary_dataset, {"metric":"bi_constraint_count","subheader":"read-only catalog constraints"}),
            ("BI indexes", "big_number_total", summary_dataset, {"metric":"bi_index_count","subheader":"read-only catalog indexes"}),
            ("BI schema and column drill", "table", detail_dataset, {"all_columns":["schema_name","relation_name","relation_kind","column_name","data_type","ordinal_position","is_nullable","receipt_id"],"order_by_cols":[],"row_limit":1000,"server_pagination":True}),
        ]:
            chart = db.session.query(Slice).filter_by(slice_name=title).one_or_none()
            if not chart:
                chart = Slice(slice_name=title, viz_type=viz, datasource_type="table", datasource_id=dataset.id)
                db.session.add(chart)
            chart.viz_type = viz
            chart.datasource_type = "table"
            chart.datasource_id = dataset.id
            chart.params = json.dumps({"adhoc_filters":[],"datasource":f"{dataset.id}__table","viz_type":viz,**params}, sort_keys=True)
            charts.append(chart)
        tech_chart_specs = [
            ("Technical schema overview", "table", tech_datasets["system"], {"all_columns":["schema_name","relation_count","column_count","stored_object_count","invalid_object_count","compile_issue_count","denied_or_unknown_collectors","coverage_all_complete","receipt_id"],"order_by_cols":[],"row_limit":1000,"server_pagination":True}),
            ("Technical table capacity", "table", tech_datasets["tables"], {"all_columns":["schema_name","relation_name","relation_kind","num_rows_estimate","last_analyzed","stale_stats","bytes","blocks","size_semantics","row_count_semantics","receipt_id"],"order_by_cols":[],"row_limit":1000,"server_pagination":True}),
            ("Technical code dependencies", "table", tech_datasets["code"], {"all_columns":["schema_name","object_name","object_kind","status","signature_count","compile_issue_count","depends_on_count","used_by_count","source_line_count","source_hash_sha256","wrapped_code_blind_spot","receipt_id"],"order_by_cols":[],"row_limit":1000,"server_pagination":True}),
            ("Technical coverage blind spots", "table", tech_datasets["coverage"], {"all_columns":["query_id","category","state","visibility","reason_code","row_count","empty_interpretation","caveat","receipt_id"],"order_by_cols":[],"row_limit":1000,"server_pagination":True}),
            ("Technical relations total", "big_number_total", tech_datasets["system"], {"metric":"SUM(relation_count)","subheader":"visible catalog relations"}),
            ("Technical estimated bytes", "big_number_total", tech_datasets["tables"], {"metric":"SUM(bytes)","subheader":"visible size metadata only"}),
            ("Technical compile issues", "big_number_total", tech_datasets["code"], {"metric":"SUM(compile_issue_count)","subheader":"visible compile issue metadata"}),
            ("Technical denied or unknown collectors", "big_number_total", tech_datasets["coverage"], {"metric":"COUNT(*)","adhoc_filters":[{"clause":"WHERE","subject":"state","operator":"IN","comparator":["DENIED","TIMEOUT","ERROR","PARTIAL"],"expressionType":"SIMPLE"}],"subheader":"coverage caveats"}),
        ]
        tech_charts = []
        for title, viz, dataset, params in tech_chart_specs:
            chart = db.session.query(Slice).filter_by(slice_name=title).one_or_none()
            if not chart:
                chart = Slice(slice_name=title, viz_type=viz, datasource_type="table", datasource_id=dataset.id)
                db.session.add(chart)
            chart.viz_type = viz
            chart.datasource_type = "table"
            chart.datasource_id = dataset.id
            chart.params = json.dumps({"adhoc_filters":[],"datasource":f"{dataset.id}__table","viz_type":viz,**params}, sort_keys=True)
            tech_charts.append(chart)
        db.session.flush()

        dashboard = db.session.query(Dashboard).filter_by(uuid=DASHBOARD_UUID).one_or_none()
        if not dashboard:
            dashboard = Dashboard(uuid=DASHBOARD_UUID, dashboard_title="KaleidoSphere Database Overview", slug="chimpmaera-bi-database-overview", published=True)
            db.session.add(dashboard)
        dashboard.dashboard_title = "KaleidoSphere Database Overview"
        dashboard.slug = "chimpmaera-bi-database-overview"
        dashboard.published = True
        dashboard.description = f"{summary['source_engine']} {summary['source_mode']} · READ-ONLY receipt {request['receiptId']} · database {summary['source_database']} · Open KaleidoSphere: {os.environ.get('AGENT_PUBLIC_URL', 'http://localhost:18790')}"
        dashboard.slices = charts
        chart_ids = [f"CHART-{chart.id}" for chart in charts]
        position = {
            "DASHBOARD_VERSION_KEY":"v2",
            "ROOT_ID":{"type":"ROOT","id":"ROOT_ID","children":["GRID_ID"]},
            "GRID_ID":{"type":"GRID","id":"GRID_ID","children":["ROW-AGENT","ROW-KPI","ROW-DETAIL"]},
            "ROW-AGENT":{"type":"ROW","id":"ROW-AGENT","children":["MARKDOWN-AGENT"],"meta":{"background":"BACKGROUND_TRANSPARENT"}},
            "MARKDOWN-AGENT":{"type":"MARKDOWN","id":"MARKDOWN-AGENT","children":[],"meta":{"width":12,"height":10,"code":f"## KaleidoSphere\n[Open KaleidoSphere]({os.environ.get('AGENT_PUBLIC_URL', 'http://localhost:18790')}) · Receipt `{request['receiptId']}` · source is read-only."}},
            "ROW-KPI":{"type":"ROW","id":"ROW-KPI","children":chart_ids[:4],"meta":{"background":"BACKGROUND_TRANSPARENT"}},
            "ROW-DETAIL":{"type":"ROW","id":"ROW-DETAIL","children":chart_ids[4:],"meta":{"background":"BACKGROUND_TRANSPARENT"}},
        }
        for index, child in enumerate(chart_ids):
            position[child] = {"type":"CHART","id":child,"children":[],"meta":{"width":3 if index < 4 else 12,"height":32 if index < 4 else 60,"chartId":charts[index].id}}
        dashboard.position_json = json.dumps(position, sort_keys=True)
        dashboard.json_metadata = json.dumps({"native_filter_configuration":[],"timed_refresh_immune_slices":[]}, sort_keys=True)

        tech_dashboard_specs = [
            ("KaleidoSphere Technical System & Schema Overview", "chimpmaera-technical-system-schema-overview", [tech_charts[0], tech_charts[4]]),
            ("KaleidoSphere Technical Tables, Freshness & Capacity", "chimpmaera-technical-tables-freshness-capacity", [tech_charts[1], tech_charts[5]]),
            ("KaleidoSphere Technical Code, Validity & Dependencies", "chimpmaera-technical-code-validity-dependencies", [tech_charts[2], tech_charts[6]]),
            ("KaleidoSphere Technical Coverage, Errors & Blind Spots", "chimpmaera-technical-coverage-errors-blind-spots", [tech_charts[3], tech_charts[7]]),
        ]
        tech_dashboards = []
        for title, slug, dashboard_charts in tech_dashboard_specs:
            tech_dashboard = db.session.query(Dashboard).filter_by(uuid=TECH_DASHBOARD_UUIDS[title]).one_or_none()
            if not tech_dashboard:
                tech_dashboard = Dashboard(uuid=TECH_DASHBOARD_UUIDS[title], dashboard_title=title, slug=slug, published=True)
                db.session.add(tech_dashboard)
            tech_dashboard.dashboard_title = title
            tech_dashboard.slug = slug
            tech_dashboard.published = True
            tech_dashboard.description = f"M3 fixed technical overview · receipt {request['receiptId']} · catalog/projection data only."
            tech_dashboard.slices = dashboard_charts
            ids = [f"CHART-{chart.id}" for chart in dashboard_charts]
            tech_position = {
                "DASHBOARD_VERSION_KEY":"v2",
                "ROOT_ID":{"type":"ROOT","id":"ROOT_ID","children":["GRID_ID"]},
                "GRID_ID":{"type":"GRID","id":"GRID_ID","children":["ROW-KPI","ROW-TABLE"]},
                "ROW-KPI":{"type":"ROW","id":"ROW-KPI","children":[ids[1]],"meta":{"background":"BACKGROUND_TRANSPARENT"}},
                "ROW-TABLE":{"type":"ROW","id":"ROW-TABLE","children":[ids[0]],"meta":{"background":"BACKGROUND_TRANSPARENT"}},
                ids[1]:{"type":"CHART","id":ids[1],"children":[],"meta":{"width":4,"height":28,"chartId":dashboard_charts[1].id}},
                ids[0]:{"type":"CHART","id":ids[0],"children":[],"meta":{"width":12,"height":72,"chartId":dashboard_charts[0].id}},
            }
            tech_dashboard.position_json = json.dumps(tech_position, sort_keys=True)
            tech_dashboard.json_metadata = json.dumps({"native_filter_configuration":[],"timed_refresh_immune_slices":[]}, sort_keys=True)
            tech_dashboards.append(tech_dashboard)
        db.session.commit()

        expected_dataset_uuids = [SUMMARY_DATASET_UUID, DETAIL_DATASET_UUID, *TECH_DATASET_UUIDS.values()]
        expected_chart_names = [chart.slice_name for chart in charts + tech_charts]
        expected_dashboard_uuids = [DASHBOARD_UUID, *TECH_DASHBOARD_UUIDS.values()]
        dataset_count = db.session.query(SqlaTable).filter(SqlaTable.uuid.in_(expected_dataset_uuids)).count()
        chart_count = db.session.query(Slice).filter(Slice.slice_name.in_(expected_chart_names)).count()
        dashboard_count = db.session.query(Dashboard).filter(Dashboard.uuid.in_(expected_dashboard_uuids)).count()
        if dataset_count != 6 or chart_count != 13 or dashboard_count != 5 or len(dashboard.slices) != 5 or any(len(item.slices) != 2 for item in tech_dashboards):
            fail("SUPERSET_READBACK_COUNT_MISMATCH")
        public = os.environ.get("SUPERSET_PUBLIC_URL", "http://localhost:18088")
        return {
            "schemaVersion":"chimpmaera.bi/superset-publication/v1",
            "status":"PUBLISHED_IDEMPOTENT",
            "receiptId":request["receiptId"],
            "datasets":dataset_count,
            "charts":chart_count,
            "dashboards":dashboard_count,
            "detailRows":detail_count,
            "technicalOverviewRows":technical_counts,
            "technicalDashboards":[{"title":title,"url":f"{public}/superset/dashboard/{slug}/"} for title, slug, _charts in tech_dashboard_specs],
            "dashboardUrl":f"{public}/superset/dashboard/chimpmaera-bi-database-overview/",
            "agentEntry":os.environ.get("AGENT_PUBLIC_URL", "http://localhost:18790"),
        }
