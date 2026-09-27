-- P6 acceptance evidence is plugin-owned. Apply after 0001-0004.
-- These records do not themselves deploy or publish any knowledge.
CREATE TABLE hz_p6_candidates (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    proposal_id VARCHAR(36) NOT NULL REFERENCES hz_p4_release_proposals (id),
    evaluation_run_id VARCHAR(36) NOT NULL REFERENCES hz_p5_eval_runs (id),
    request_hash CHAR(64) NOT NULL,
    dataset_revision BIGINT NOT NULL,
    config_fingerprint CHAR(64) NOT NULL,
    code_version VARCHAR(128) NOT NULL,
    frozen_config JSONB NOT NULL,
    created_by VARCHAR(512) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, proposal_id)
);
CREATE TRIGGER hz_p6_candidates_immutable BEFORE UPDATE OR DELETE ON hz_p6_candidates
    FOR EACH ROW EXECUTE FUNCTION hz_reject_immutable_change();

CREATE TABLE hz_p6_evidence (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    candidate_id VARCHAR(36) NOT NULL REFERENCES hz_p6_candidates (id),
    gate VARCHAR(32) NOT NULL,
    reference VARCHAR(256) NOT NULL,
    sha256 CHAR(64) NOT NULL,
    environment VARCHAR(16) NOT NULL CHECK (environment IN ('staging', 'production')),
    verified_by VARCHAR(512) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, candidate_id, gate)
);
CREATE TRIGGER hz_p6_evidence_immutable BEFORE UPDATE OR DELETE ON hz_p6_evidence
    FOR EACH ROW EXECUTE FUNCTION hz_reject_immutable_change();

CREATE TABLE hz_p6_signoffs (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    candidate_id VARCHAR(36) NOT NULL REFERENCES hz_p6_candidates (id),
    role VARCHAR(16) NOT NULL CHECK (role IN ('business', 'technical')),
    signed_by VARCHAR(512) NOT NULL,
    reason VARCHAR(512) NOT NULL,
    signed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, candidate_id, role)
);
CREATE TRIGGER hz_p6_signoffs_immutable BEFORE UPDATE OR DELETE ON hz_p6_signoffs
    FOR EACH ROW EXECUTE FUNCTION hz_reject_immutable_change();
