-- P4 governance is plugin-owned. Apply after 0001 and 0002; it does not alter upstream WeKnora tables.
CREATE TABLE hz_p4_review_cases (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('duplicate', 'conflict', 'cleaning')),
    left_ref VARCHAR(256) NOT NULL,
    right_ref VARCHAR(256) NOT NULL,
    left_hash CHAR(64) NOT NULL,
    right_hash CHAR(64) NOT NULL,
    document_ids JSONB NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
    revision BIGINT NOT NULL DEFAULT 1,
    created_by VARCHAR(512) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_at TIMESTAMPTZ
);
CREATE INDEX hz_p4_review_pending ON hz_p4_review_cases (tenant_id, knowledge_base_id, created_at)
    WHERE status='pending';

CREATE TABLE hz_p4_review_decisions (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    case_id VARCHAR(36) NOT NULL,
    action VARCHAR(32) NOT NULL,
    reason VARCHAR(512) NOT NULL,
    decided_by VARCHAR(512) NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (case_id) REFERENCES hz_p4_review_cases (id)
);
CREATE TRIGGER hz_p4_review_decisions_immutable BEFORE UPDATE OR DELETE ON hz_p4_review_decisions
    FOR EACH ROW EXECUTE FUNCTION hz_reject_immutable_change();

CREATE TABLE hz_p4_release_proposals (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    expected_release_id VARCHAR(36),
    idempotency_key VARCHAR(256) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    entries JSONB NOT NULL,
    preview JSONB NOT NULL,
    reason VARCHAR(512) NOT NULL,
    rollback_of VARCHAR(36),
    publish_not_before TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected', 'published')),
    revision BIGINT NOT NULL DEFAULT 1,
    proposed_by VARCHAR(512) NOT NULL,
    approved_by VARCHAR(512),
    approval_reason VARCHAR(512),
    released_id VARCHAR(36),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    approved_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    UNIQUE (tenant_id, knowledge_base_id, idempotency_key)
);
CREATE INDEX hz_p4_proposals_pending ON hz_p4_release_proposals (tenant_id, knowledge_base_id, status, created_at);

CREATE FUNCTION hz_p4_require_approved_release() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM hz_p4_release_proposals p
        WHERE p.tenant_id=NEW.tenant_id AND p.knowledge_base_id=NEW.knowledge_base_id
          AND p.idempotency_key=NEW.idempotency_key AND p.request_hash=NEW.request_hash
          AND p.expected_release_id IS NOT DISTINCT FROM NEW.base_release_id
          AND p.status='approved' AND p.publish_not_before <= CURRENT_TIMESTAMP
          AND NOT EXISTS (
              SELECT 1 FROM hz_p4_review_cases c,
                  jsonb_array_elements_text(c.document_ids) AS reviewed_document,
                  jsonb_array_elements(p.entries) AS proposed_entry
              WHERE c.tenant_id=p.tenant_id AND c.knowledge_base_id=p.knowledge_base_id
                AND c.status='pending' AND reviewed_document.value=proposed_entry.value->>'documentId'
          )
    ) THEN
        RAISE EXCEPTION 'governance approval required';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hz_p4_release_approval BEFORE INSERT ON hz_releases
    FOR EACH ROW EXECUTE FUNCTION hz_p4_require_approved_release();

CREATE TABLE hz_p4_entities (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    canonical_name VARCHAR(256) NOT NULL,
    entity_type VARCHAR(64) NOT NULL,
    created_by VARCHAR(512) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, knowledge_base_id, entity_type, canonical_name)
);
CREATE TABLE hz_p4_entity_aliases (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    entity_id VARCHAR(36) NOT NULL REFERENCES hz_p4_entities (id),
    alias VARCHAR(256) NOT NULL,
    source_ref VARCHAR(256) NOT NULL,
    confirmed_by VARCHAR(512) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, knowledge_base_id, entity_id, alias)
);
CREATE INDEX hz_p4_alias_lookup ON hz_p4_entity_aliases (tenant_id, knowledge_base_id, alias);

CREATE TABLE hz_p4_rule_suggestions (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    source_ref VARCHAR(256) NOT NULL,
    rule_data JSONB NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'confirmed', 'rejected')),
    created_by VARCHAR(512) NOT NULL,
    confirmed_by VARCHAR(512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, knowledge_base_id, source_ref, id)
);

CREATE TABLE hz_p4_derived_assets (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('summary', 'faq', 'wiki', 'graph')),
    object_ref TEXT NOT NULL,
    sources JSONB NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'quarantined')),
    created_by VARCHAR(512) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    quarantined_at TIMESTAMPTZ
);
CREATE INDEX hz_p4_derived_lookup ON hz_p4_derived_assets (tenant_id, knowledge_base_id, status);
