FROM caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f
RUN setcap -r /usr/bin/caddy \
    && addgroup -S -g 10001 multai \
    && adduser -S -D -H -u 10001 -G multai multai \
    && mkdir -p /data/caddy /config/caddy \
    && chown -R multai:multai /data /config
USER multai
