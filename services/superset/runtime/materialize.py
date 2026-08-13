import hashlib
import json
import os
import sqlite3
from pathlib import Path

from superset.app import create_app

SUMMARY_DATASET_UUID = "b1000000-0000-4000-8000-000000000001"
DETAIL_DATASET_UUID = "b1000000-0000-4000-8000-000000000002"
DASHBOARD_UUID = "b1000000-0000-4000-8000-000000000003"
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
    finally:
        connection.close()
    if not summary or summary["snapshot_sha256"] != request["snapshotSha256"] or summary["source_read_only"] != 1:
        fail("SUPERSET_PROJECTION_BINDING_MISMATCH")
    return dict(summary), detail_count

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
    summary, detail_count = source_readback(request)
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
        db.session.flush()

        dashboard = db.session.query(Dashboard).filter_by(uuid=DASHBOARD_UUID).one_or_none()
        if not dashboard:
            dashboard = Dashboard(uuid=DASHBOARD_UUID, dashboard_title="ChimpMaera BI Database Overview", slug="chimpmaera-bi-database-overview", published=True)
            db.session.add(dashboard)
        dashboard.dashboard_title = "ChimpMaera BI Database Overview"
        dashboard.slug = "chimpmaera-bi-database-overview"
        dashboard.published = True
        dashboard.description = f"{summary['source_engine']} {summary['source_mode']} · READ-ONLY receipt {request['receiptId']} · database {summary['source_database']} · Open BI Agent: {os.environ.get('AGENT_PUBLIC_URL', 'http://localhost:18790')}"
        dashboard.slices = charts
        chart_ids = [f"CHART-{chart.id}" for chart in charts]
        position = {
            "DASHBOARD_VERSION_KEY":"v2",
            "ROOT_ID":{"type":"ROOT","id":"ROOT_ID","children":["GRID_ID"]},
            "GRID_ID":{"type":"GRID","id":"GRID_ID","children":["ROW-AGENT","ROW-KPI","ROW-DETAIL"]},
            "ROW-AGENT":{"type":"ROW","id":"ROW-AGENT","children":["MARKDOWN-AGENT"],"meta":{"background":"BACKGROUND_TRANSPARENT"}},
            "MARKDOWN-AGENT":{"type":"MARKDOWN","id":"MARKDOWN-AGENT","children":[],"meta":{"width":12,"height":10,"code":f"## BI Agent\n[Open BI Agent]({os.environ.get('AGENT_PUBLIC_URL', 'http://localhost:18790')}) · Receipt `{request['receiptId']}` · source is read-only."}},
            "ROW-KPI":{"type":"ROW","id":"ROW-KPI","children":chart_ids[:4],"meta":{"background":"BACKGROUND_TRANSPARENT"}},
            "ROW-DETAIL":{"type":"ROW","id":"ROW-DETAIL","children":chart_ids[4:],"meta":{"background":"BACKGROUND_TRANSPARENT"}},
        }
        for index, child in enumerate(chart_ids):
            position[child] = {"type":"CHART","id":child,"children":[],"meta":{"width":3 if index < 4 else 12,"height":32 if index < 4 else 60,"chartId":charts[index].id}}
        dashboard.position_json = json.dumps(position, sort_keys=True)
        dashboard.json_metadata = json.dumps({"native_filter_configuration":[],"timed_refresh_immune_slices":[]}, sort_keys=True)
        db.session.commit()

        dataset_count = db.session.query(SqlaTable).filter(SqlaTable.uuid.in_([SUMMARY_DATASET_UUID, DETAIL_DATASET_UUID])).count()
        chart_count = db.session.query(Slice).filter(Slice.slice_name.in_([chart.slice_name for chart in charts])).count()
        dashboard_count = db.session.query(Dashboard).filter_by(uuid=DASHBOARD_UUID).count()
        if dataset_count != 2 or chart_count != 5 or dashboard_count != 1 or len(dashboard.slices) != 5:
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
            "dashboardUrl":f"{public}/superset/dashboard/chimpmaera-bi-database-overview/",
            "agentEntry":os.environ.get("AGENT_PUBLIC_URL", "http://localhost:18790"),
        }
