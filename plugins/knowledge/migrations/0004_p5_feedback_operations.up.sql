-- P5 plugin-owned feedback, evaluation and operational evidence. Apply after 0001-0003.
CREATE TABLE hz_p5_answer_receipts (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    trace_id VARCHAR(128) NOT NULL,
    requester_id VARCHAR(512) NOT NULL,
    question_hash CHAR(64) NOT NULL,
    delivery_status VARCHAR(16) NOT NULL CHECK (delivery_status IN ('ready', 'rejected')),
    source_refs JSONB NOT NULL,
    search_version VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, trace_id)
);
CREATE TRIGGER hz_p5_answer_receipts_immutable BEFORE UPDATE OR DELETE ON hz_p5_answer_receipts
    FOR EACH ROW EXECUTE FUNCTION hz_reject_immutable_change();

CREATE TABLE hz_p5_feedback (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    receipt_id VARCHAR(36) NOT NULL REFERENCES hz_p5_answer_receipts (id),
    idempotency_key VARCHAR(256) NOT NULL,
    category VARCHAR(40) NOT NULL,
    comment VARCHAR(1000) NOT NULL,
    submitted_by VARCHAR(512) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'promoted', 'rejected')),
    reviewed_by VARCHAR(512),
    review_reason VARCHAR(512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMPTZ,
    UNIQUE (tenant_id, receipt_id, idempotency_key)
);
CREATE INDEX hz_p5_feedback_queue ON hz_p5_feedback (tenant_id, knowledge_base_id, status, created_at);

CREATE TABLE hz_p5_dataset_state (
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, knowledge_base_id)
);
CREATE TABLE hz_p5_eval_cases (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    dataset_revision BIGINT NOT NULL,
    feedback_id VARCHAR(36) NOT NULL UNIQUE REFERENCES hz_p5_feedback (id),
    question TEXT NOT NULL,
    expected_status VARCHAR(32) NOT NULL,
    required_refs JSONB NOT NULL,
    forbidden_refs JSONB NOT NULL,
    document_type VARCHAR(40) NOT NULL,
    question_type VARCHAR(40) NOT NULL,
    as_of TIMESTAMPTZ,
    created_by VARCHAR(512) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX hz_p5_eval_cases_revision ON hz_p5_eval_cases
    (tenant_id, knowledge_base_id, dataset_revision);
CREATE TRIGGER hz_p5_eval_cases_immutable BEFORE UPDATE OR DELETE ON hz_p5_eval_cases
    FOR EACH ROW EXECUTE FUNCTION hz_reject_immutable_change();

CREATE TABLE hz_p5_eval_runs (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    proposal_id VARCHAR(36) NOT NULL REFERENCES hz_p4_release_proposals (id),
    request_hash CHAR(64) NOT NULL,
    dataset_revision BIGINT NOT NULL,
    config_fingerprint VARCHAR(256) NOT NULL,
    code_version VARCHAR(128) NOT NULL,
    status VARCHAR(16) NOT NULL CHECK (status IN ('passed', 'failed')),
    case_count INTEGER NOT NULL CHECK (case_count > 0),
    results JSONB NOT NULL,
    run_by VARCHAR(512) NOT NULL,
    approved_by VARCHAR(512),
    approval_reason VARCHAR(512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    approved_at TIMESTAMPTZ
);
CREATE INDEX hz_p5_eval_run_gate ON hz_p5_eval_runs
    (tenant_id, knowledge_base_id, proposal_id, dataset_revision, status);

CREATE FUNCTION hz_p5_eval_run_approval_only() RETURNS trigger AS $$
DECLARE proposal_author VARCHAR(512);
BEGIN
    IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'immutable evaluation run';
    END IF;
    SELECT proposed_by INTO proposal_author FROM hz_p4_release_proposals WHERE id=OLD.proposal_id;
    IF OLD.approved_by IS NOT NULL OR NEW.approved_by IS NULL OR
       NEW.approved_by=OLD.run_by OR NEW.approved_by=proposal_author OR
       NEW.approval_reason IS NULL OR trim(NEW.approval_reason)='' OR NEW.approved_at IS NULL OR
       NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
       NEW.knowledge_base_id IS DISTINCT FROM OLD.knowledge_base_id OR
       NEW.proposal_id IS DISTINCT FROM OLD.proposal_id OR
       NEW.request_hash IS DISTINCT FROM OLD.request_hash OR
       NEW.dataset_revision IS DISTINCT FROM OLD.dataset_revision OR
       NEW.config_fingerprint IS DISTINCT FROM OLD.config_fingerprint OR
       NEW.code_version IS DISTINCT FROM OLD.code_version OR
       NEW.status IS DISTINCT FROM OLD.status OR NEW.case_count IS DISTINCT FROM OLD.case_count OR
       NEW.results IS DISTINCT FROM OLD.results OR NEW.run_by IS DISTINCT FROM OLD.run_by OR
       NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'immutable evaluation run';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hz_p5_eval_run_approval_only BEFORE UPDATE OR DELETE ON hz_p5_eval_runs
    FOR EACH ROW EXECUTE FUNCTION hz_p5_eval_run_approval_only();

CREATE FUNCTION hz_p5_approved_eval_exists(p_tenant BIGINT, p_proposal VARCHAR,
    p_hash CHAR) RETURNS boolean AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM hz_p5_eval_runs e
        JOIN hz_p5_dataset_state d ON d.tenant_id=e.tenant_id
            AND d.knowledge_base_id=e.knowledge_base_id
            AND d.revision=e.dataset_revision
        WHERE e.tenant_id=p_tenant AND e.proposal_id=p_proposal
          AND e.request_hash=p_hash AND e.status='passed'
          AND e.approved_by IS NOT NULL AND e.case_count > 0
    );
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION hz_p5_require_proposal_eval() RETURNS trigger AS $$
BEGIN
    IF NEW.status='approved' AND OLD.status IS DISTINCT FROM 'approved'
       AND NOT hz_p5_approved_eval_exists(NEW.tenant_id, NEW.id, NEW.request_hash) THEN
        RAISE EXCEPTION 'evaluation approval required';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hz_p5_proposal_eval BEFORE UPDATE OF status ON hz_p4_release_proposals
    FOR EACH ROW EXECUTE FUNCTION hz_p5_require_proposal_eval();

CREATE FUNCTION hz_p5_require_release_eval() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM hz_p4_release_proposals p
        WHERE p.tenant_id=NEW.tenant_id AND p.knowledge_base_id=NEW.knowledge_base_id
          AND p.idempotency_key=NEW.idempotency_key AND p.request_hash=NEW.request_hash
          AND hz_p5_approved_eval_exists(p.tenant_id, p.id, p.request_hash)
    ) THEN
        RAISE EXCEPTION 'evaluation approval required';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hz_p5_release_eval BEFORE INSERT ON hz_releases
    FOR EACH ROW EXECUTE FUNCTION hz_p5_require_release_eval();

CREATE TABLE hz_p5_faq_approvals (
    asset_id VARCHAR(36) PRIMARY KEY REFERENCES hz_p4_derived_assets (id),
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    approved_by VARCHAR(512) NOT NULL,
    approved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE hz_p5_metrics (
    id VARCHAR(36) PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    knowledge_base_id VARCHAR(36) NOT NULL,
    trace_id VARCHAR(128) NOT NULL,
    stage VARCHAR(32) NOT NULL,
    outcome VARCHAR(32) NOT NULL,
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    token_count INTEGER NOT NULL CHECK (token_count >= 0),
    cost_micros BIGINT NOT NULL CHECK (cost_micros >= 0),
    http_status INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX hz_p5_metrics_window ON hz_p5_metrics (tenant_id, knowledge_base_id, created_at);
