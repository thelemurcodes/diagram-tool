# Setup guide — retired

The Google Cloud Function setup described in earlier versions of this file is
retired: the backend now runs on Railway from `main`, with data in Postgres on
Neon. No deploy script holds a key, and the legacy GCP project and its Firestore
data remain untouched.

For the current status, live URLs, local development, and operations, see
[`README.md`](README.md) and [`docs/infrastructure.md`](docs/infrastructure.md).
