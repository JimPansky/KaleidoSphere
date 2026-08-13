FROM apache/superset:5.0.0@sha256:e51bbaf8b72d7c864d6e1e3e439c476db55481d0eb89e04ac411cc1c5344746c
LABEL org.opencontainers.image.title="ChimpMaera BI Superset M0" \
      io.chimpmaera.bi.role="owned-superset"
USER root
COPY --chown=superset:superset services/superset/runtime/ /opt/chimpmaera-bi/
RUN chmod 0555 /opt/chimpmaera-bi/*.sh /opt/chimpmaera-bi/*.py
USER superset
CMD ["/opt/chimpmaera-bi/start.sh"]
