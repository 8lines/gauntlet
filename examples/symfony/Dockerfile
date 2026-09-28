ARG PHP_IMAGE=php:8.3.33-cli-bookworm@sha256:177529735599a8244b2c903522f029839dce1c2ac4be122fdc00ada4b45a20e4
ARG COMPOSER_IMAGE=composer:2.10.3@sha256:4d045ea9f71d5d111a95e608400da61d187e487adf9eaf2dfe068998a8d4f584

FROM ${COMPOSER_IMAGE} AS composer
FROM ${PHP_IMAGE}

RUN apt-get update \
    && apt-get install -y --no-install-recommends git unzip \
    && rm -rf /var/lib/apt/lists/*

RUN php -r 'foreach (["curl", "dom", "hash", "json", "libxml", "mbstring", "pdo", "pdo_sqlite"] as $extension) { if (!extension_loaded($extension)) { fwrite(STDERR, "Missing PHP extension: $extension\n"); exit(1); } }'

COPY --from=composer /usr/bin/composer /usr/bin/composer

WORKDIR /workspace/examples/symfony

COPY packages/php/core /workspace/packages/php/core
COPY packages/php/symfony-bundle /workspace/packages/php/symfony-bundle
COPY examples/symfony /workspace/examples/symfony
COPY conformance /workspace/conformance

RUN composer install --no-interaction --prefer-dist

RUN install -d -o www-data -g www-data -m 0750 /tmp/gauntlet-symfony-example

EXPOSE 8080

USER www-data:www-data

CMD ["php", "-S", "0.0.0.0:8080", "-t", "public", "public/index.php"]
