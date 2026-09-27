-- Knowledge plugin schema. Apply after the locked WeKnora v0.8.2 schema on PostgreSQL.
-- This plugin owns hz_* tables; no upstream table is modified in P1.

CREATE TABLE hz_documents (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    organization_id VARCHAR(128) NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    source_system VARCHAR(128) NOT NULL,
    source_document_id VARCHAR(512) NOT NULL,
    owner_id VARCHAR(512) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, knowledge_base_id, source_system, source_document_id)
);

CREATE TABLE hz_document_versions (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    document_id VARCHAR(36) NOT NULL,
    source_revision VARCHAR(256) NOT NULL,
    content_hash CHAR(64) NOT NULL,
    object_ref TEXT NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(512) NOT NULL,
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, document_id, source_revision),
    FOREIGN KEY (tenant_id, document_id) REFERENCES hz_documents (tenant_id, id)
);

CREATE TABLE hz_builds (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    version_id VARCHAR(36) NOT NULL,
    pipeline_fingerprint VARCHAR(256) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'processing', 'ready', 'failed')),
    lease_generation BIGINT NOT NULL DEFAULT 0,
    index_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, version_id, pipeline_fingerprint),
    FOREIGN KEY (tenant_id, version_id) REFERENCES hz_document_versions (tenant_id, id)
);

CREATE TABLE hz_processing_runs (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    build_id VARCHAR(36) NOT NULL,
    idempotency_key VARCHAR(256) NOT NULL,
    generation BIGINT NOT NULL,
    status VARCHAR(16) NOT NULL CHECK (status IN ('processing', 'completed', 'superseded', 'failed')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, build_id) REFERENCES hz_builds (tenant_id, id)
);

CREATE TABLE hz_acl_rules (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    resource_type VARCHAR(24) NOT NULL CHECK (resource_type IN ('knowledge_base', 'document')),
    resource_id VARCHAR(36) NOT NULL,
    principal_type VARCHAR(24) NOT NULL CHECK (principal_type IN ('user', 'department', 'group', 'everyone')),
    principal_id VARCHAR(512) NOT NULL,
    effect VARCHAR(8) NOT NULL CHECK (effect IN ('allow', 'deny')),
    created_by VARCHAR(512) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMPTZ,
    CHECK (resource_type <> 'knowledge_base' OR resource_id = knowledge_base_id)
);
CREATE INDEX hz_acl_rules_resource ON hz_acl_rules (tenant_id, knowledge_base_id, resource_type, resource_id) WHERE revoked_at IS NULL;

CREATE TABLE hz_acl_revisions (
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, knowledge_base_id)
);

CREATE TABLE hz_releases (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    base_release_id VARCHAR(36),
    idempotency_key VARCHAR(256) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    epoch BIGINT NOT NULL,
    published_by VARCHAR(512) NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, knowledge_base_id, idempotency_key)
);

CREATE TABLE hz_release_entries (
    tenant_id BIGINT NOT NULL,
    release_id VARCHAR(36) NOT NULL,
    document_id VARCHAR(36) NOT NULL,
    version_id VARCHAR(36) NOT NULL,
    build_id VARCHAR(36) NOT NULL,
    effective_from TIMESTAMPTZ NOT NULL,
    effective_to TIMESTAMPTZ,
    PRIMARY KEY (release_id, document_id, effective_from),
    FOREIGN KEY (tenant_id, release_id) REFERENCES hz_releases (tenant_id, id),
    FOREIGN KEY (tenant_id, document_id) REFERENCES hz_documents (tenant_id, id),
    FOREIGN KEY (tenant_id, version_id) REFERENCES hz_document_versions (tenant_id, id),
    FOREIGN KEY (tenant_id, build_id) REFERENCES hz_builds (tenant_id, id),
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX hz_release_entries_current ON hz_release_entries (tenant_id, release_id, version_id, build_id);

CREATE TABLE hz_active_releases (
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    release_id VARCHAR(36),
    epoch BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, knowledge_base_id),
    FOREIGN KEY (tenant_id, release_id) REFERENCES hz_releases (tenant_id, id)
);

CREATE TABLE hz_version_revocations (
    tenant_id BIGINT NOT NULL,
    version_id VARCHAR(36) NOT NULL,
    reason VARCHAR(512) NOT NULL,
    revoked_by VARCHAR(512) NOT NULL,
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, version_id),
    FOREIGN KEY (tenant_id, version_id) REFERENCES hz_document_versions (tenant_id, id)
);

CREATE TABLE hz_outbox (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    topic VARCHAR(128) NOT NULL,
    aggregate_id VARCHAR(36) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    claimed_until TIMESTAMPTZ,
    lease_token VARCHAR(36),
    attempts INTEGER NOT NULL DEFAULT 0,
    delivered_at TIMESTAMPTZ
);
CREATE INDEX hz_outbox_pending ON hz_outbox (available_at, id) WHERE delivered_at IS NULL;

CREATE TABLE hz_audit_events (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    actor_id VARCHAR(512) NOT NULL,
    action VARCHAR(128) NOT NULL,
    resource_type VARCHAR(32) NOT NULL,
    resource_id VARCHAR(36) NOT NULL,
    result VARCHAR(16) NOT NULL,
    reason VARCHAR(512),
    trace_id VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX hz_audit_events_resource ON hz_audit_events (tenant_id, resource_type, resource_id, created_at DESC);

CREATE FUNCTION hz_reject_immutable_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'immutable record: %', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hz_document_versions_immutable BEFORE UPDATE OR DELETE ON hz_document_versions
    FOR EACH ROW EXECUTE FUNCTION hz_reject_immutable_change();
CREATE TRIGGER hz_releases_immutable BEFORE UPDATE OR DELETE ON hz_releases
    FOR EACH ROW EXECUTE FUNCTION hz_reject_immutable_change();
CREATE TRIGGER hz_release_entries_immutable BEFORE UPDATE OR DELETE ON hz_release_entries
    FOR EACH ROW EXECUTE FUNCTION hz_reject_immutable_change();
CREATE TRIGGER hz_version_revocations_immutable BEFORE UPDATE OR DELETE ON hz_version_revocations
    FOR EACH ROW EXECUTE FUNCTION hz_reject_immutable_change();
CREATE TRIGGER hz_audit_events_immutable BEFORE UPDATE OR DELETE ON hz_audit_events
    FOR EACH ROW EXECUTE FUNCTION hz_reject_immutable_change();
