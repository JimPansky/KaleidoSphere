FROM apache/superset:6.1.0@sha256:fb3464528ec7076f91195f0ff7835755aa023e281f1bb78a84782ce7a36b3705
LABEL org.opencontainers.image.title="ChimpMaera BI Superset M0" \
      io.chimpmaera.bi.role="owned-superset"
USER root
COPY --chown=superset:superset services/superset/runtime/ /opt/chimpmaera-bi/
RUN chmod 0555 /opt/chimpmaera-bi/*.sh /opt/chimpmaera-bi/*.py
USER superset
CMD ["/opt/chimpmaera-bi/start.sh"]
