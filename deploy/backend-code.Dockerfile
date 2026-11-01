# Source-only update for an already installed backend with unchanged package dependencies.
# BASE_IMAGE must be a locally retained tag of the currently running image.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
WORKDIR /usr/src/app
COPY backend/src ./src
COPY backend/scripts ./scripts
COPY backend/migrations ./migrations
