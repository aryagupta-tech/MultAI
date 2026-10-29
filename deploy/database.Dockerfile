FROM postgres:18-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5
USER root
RUN mkdir -p /var/lib/postgresql/18/docker /var/run/postgresql \
    && chown -R postgres:postgres /var/lib/postgresql /var/run/postgresql
COPY --chown=postgres:postgres deploy/init-database.sh /docker-entrypoint-initdb.d/10-multai-app.sh
RUN chmod 0755 /docker-entrypoint-initdb.d/10-multai-app.sh
USER postgres
