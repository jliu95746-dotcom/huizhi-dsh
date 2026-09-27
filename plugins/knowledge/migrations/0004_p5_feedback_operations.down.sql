-- Destructive for P5 feedback/evaluation/metrics data. Back up and rehearse before use.
DROP TRIGGER IF EXISTS hz_p5_release_eval ON hz_releases;
DROP FUNCTION IF EXISTS hz_p5_require_release_eval();
DROP TRIGGER IF EXISTS hz_p5_proposal_eval ON hz_p4_release_proposals;
DROP FUNCTION IF EXISTS hz_p5_require_proposal_eval();
DROP FUNCTION IF EXISTS hz_p5_approved_eval_exists(BIGINT, VARCHAR, CHAR);
DROP TABLE IF EXISTS hz_p5_metrics;
DROP TABLE IF EXISTS hz_p5_faq_approvals;
DROP TRIGGER IF EXISTS hz_p5_eval_run_approval_only ON hz_p5_eval_runs;
DROP FUNCTION IF EXISTS hz_p5_eval_run_approval_only();
DROP TABLE IF EXISTS hz_p5_eval_runs;
DROP TRIGGER IF EXISTS hz_p5_eval_cases_immutable ON hz_p5_eval_cases;
DROP TABLE IF EXISTS hz_p5_eval_cases;
DROP TABLE IF EXISTS hz_p5_dataset_state;
DROP TABLE IF EXISTS hz_p5_feedback;
DROP TRIGGER IF EXISTS hz_p5_answer_receipts_immutable ON hz_p5_answer_receipts;
DROP TABLE IF EXISTS hz_p5_answer_receipts;
