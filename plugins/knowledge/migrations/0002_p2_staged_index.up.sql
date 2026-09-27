-- P2 plugin-owned staging metadata. Real keyword/vector data remains in the configured index sink.
CREATE TABLE hz_p2_index_manifests (
    tenant_id BIGINT NOT NULL,
    build_id VARCHAR(36) NOT NULL,
    generation BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    document_id VARCHAR(36) NOT NULL,
    version_id VARCHAR(36) NOT NULL,
    model_identity VARCHAR(256) NOT NULL,
    dimensions INTEGER NOT NULL CHECK (dimensions > 0),
    chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
    parent_ids JSONB NOT NULL,
    manifest_hash CHAR(64) NOT NULL,
    receipt_ref TEXT NOT NULL,
    staged_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, build_id),
    FOREIGN KEY (tenant_id, build_id) REFERENCES hz_builds (tenant_id, id)
);

CREATE TABLE hz_p2_index_entries (
    tenant_id BIGINT NOT NULL,
    build_id VARCHAR(36) NOT NULL,
    chunk_id CHAR(64) NOT NULL,
    parent_id CHAR(64) NOT NULL,
    content_hash CHAR(64) NOT NULL,
    vector_hash CHAR(64) NOT NULL,
    keyword_hash CHAR(64) NOT NULL,
    source_locations JSONB NOT NULL,
    PRIMARY KEY (tenant_id, build_id, chunk_id),
    FOREIGN KEY (tenant_id, build_id) REFERENCES hz_p2_index_manifests (tenant_id, build_id)
);
CREATE INDEX hz_p2_entries_parent ON hz_p2_index_entries (tenant_id, build_id, parent_id);

CREATE TABLE hz_p2_processing_artifacts (
    tenant_id BIGINT NOT NULL,
    build_id VARCHAR(36) NOT NULL,
    generation BIGINT NOT NULL,
    artifact_ref TEXT NOT NULL,
    quality_issues JSONB NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('review_required', 'staged', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, build_id, generation),
    FOREIGN KEY (tenant_id, build_id) REFERENCES hz_builds (tenant_id, id)
);
CREATE INDEX hz_p2_artifacts_review ON hz_p2_processing_artifacts (tenant_id, status, created_at)
    WHERE status='review_required';
