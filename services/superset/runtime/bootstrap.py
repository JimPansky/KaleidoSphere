import os
from pathlib import Path

from superset.app import create_app

def secret(name):
    value = Path(f"/run/secrets/{name}").read_text(encoding="utf-8").strip()
    if not value:
        raise RuntimeError(f"{name.upper()}_MISSING")
    return value

def deny_analyst_permissions(role):
    forbidden = ("sql lab", "sql query", "database", "dataset", "datasource", "upload", "plugin", "css template", "saved query")
    for permission in list(role.permissions):
        key = f"{permission.permission.name} {permission.view_menu.name}".lower()
        if permission.permission.name in {"can_add", "can_edit", "can_write", "can_delete", "can_upload"} or any(value in key for value in forbidden):
            role.permissions.remove(permission)

app = create_app()
with app.app_context():
    from superset import db
    from superset.models.core import Database

    sm = app.appbuilder.sm
    admin_password = secret("superset_admin_password")
    analyst_password = secret("superset_analyst_password")
    admin = sm.find_user(username="cm_admin")
    if admin:
        sm.reset_password(admin.id, admin_password)
    else:
        sm.add_user("cm_admin", "ChimpMaera", "Administrator", "admin@localhost.invalid", sm.find_role("Admin"), admin_password)

    analyst_role = sm.find_role("ChimpMaera BI Analyst") or sm.add_role("ChimpMaera BI Analyst")
    gamma = sm.find_role("Gamma")
    for permission in gamma.permissions:
        if permission not in analyst_role.permissions:
            analyst_role.permissions.append(permission)
    deny_analyst_permissions(analyst_role)
    analyst = sm.find_user(username="analyst")
    if analyst:
        if analyst_role not in analyst.roles:
            analyst.roles.append(analyst_role)
        sm.reset_password(analyst.id, analyst_password)
    else:
        sm.add_user("analyst", "BI", "Analyst", "analyst@localhost.invalid", analyst_role, analyst_password)

    database = db.session.query(Database).filter_by(database_name="ChimpMaera BI managed projection").one_or_none()
    if not database:
        database = Database(
            database_name="ChimpMaera BI managed projection",
            sqlalchemy_uri="sqlite:////var/lib/chimpmaera-bi/projection/analytics.db",
            allow_dml=False,
            expose_in_sqllab=False,
        )
        db.session.add(database)
    else:
        database.allow_dml = False
        database.expose_in_sqllab = False
    db.session.commit()
