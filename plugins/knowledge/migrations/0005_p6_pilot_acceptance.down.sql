-- Destructive for P6 acceptance evidence. Back up and rehearse before use.
DROP TRIGGER IF EXISTS hz_p6_signoffs_immutable ON hz_p6_signoffs;
DROP TABLE IF EXISTS hz_p6_signoffs;
DROP TRIGGER IF EXISTS hz_p6_evidence_immutable ON hz_p6_evidence;
DROP TABLE IF EXISTS hz_p6_evidence;
DROP TRIGGER IF EXISTS hz_p6_candidates_immutable ON hz_p6_candidates;
DROP TABLE IF EXISTS hz_p6_candidates;
