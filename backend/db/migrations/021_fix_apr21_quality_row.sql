-- 021: replace the fabricated 2026-04-21 Quality/Lab row with the real lab sheet.
--
-- Migration 015 seeded one 'quality' row — the only one that has ever
-- existed — and its ten values were mockup figures, not lab results:
-- blaine_425r 3680 against a real 358, coal_residue 4.5 against a real
-- 13.35, six lsf_rm_h* readings around 96.5 against a real day average of
-- 110.65. It was the demo data the page was built from, filed as if it
-- were a report.
--
-- Two things made leaving it alone untenable rather than merely untidy:
--
--   1. 2026-09-22 rebuilt forms/quality-form.html around the plant's own
--      QC DAILY REPORT workbook. The six four-hourly lsf_rm_h1..h6 fields
--      no longer exist (Raw Mill now holds one day average, lsf_rm), so
--      those six values had become orphans no page could read.
--
--   2. blaine_425r is now declared in m²/kg — the unit the workbook and
--      the TBS requirement it prints are both written in — where it was
--      previously cm²/g. 3680 read as m²/kg is ten times the real figure
--      and would have sat at the top of the Blaine KPI as a permanent
--      outlier.
--
-- The replacement is the genuine 21-Apr-2026 sheet
-- (data/samples/2026-04-21/6. Quality Report 21.04.2026 (2).xlsx), run
-- through the same forms/excel-import.js extractor the QC manager's
-- "Import Excel" button uses — so this row is also the end-to-end proof
-- that the importer and the form agree on every field name.
--
-- Idempotent: it rewrites one known row by (form_type, record_date) and
-- does nothing if that row is absent. Status, author and approval
-- columns are left exactly as migration 015 set them.
UPDATE daily_reports
   SET data = $qc021${"date":"2026-04-21","prepared_by":"","blaine_425r":"358","cem_cm1_425r_r45":"9.96","cem_cm1_425r_lce":"15.50","cem_cm1_425r_cs1":"13.74","cem_cm1_425r_cs2":"23.26","strength_28d":"49.45","cem_cm1_425n_lce":"16.00","cem_cm1_425n_cs1":"10.68","cem_cm1_bmill_blaine":"339","cem_cm1_bmill_r45":"22.44","cem_cm1_bmill_lce":"104.00","cem_cm1_bmill_cs1":"15.37","cem_cm1_bmill_cs2":"25.45","cem_cm1_bmill_cs7":"36.69","cem_cm2_425r_cs7":"36.28","cem_cm2_425r_cs28":"45.22","cem_cm2_425n_cs28":"44.17","cem_ld_425r_blaine":"361","cem_ld_425r_r45":"11.34","cem_ld_425r_lce":"1.50","cem_ld_425r_cs1":"13.21","cem_ld_425r_cs2":"23.02","cem_ld_425r_cs7":"33.60","cem_ld_425r_cs28":"46.46","cem_ld_425n_cs2":"21.97","cem_ld_425n_cs7":"32.49","cem_ld_425n_cs28":"46.08","cem_ld_opc_lce":"3.00","cem_ld_opc_cs1":"15.59","coal_moisture":"7.57","coal_residue":"13.35","coal_r212":"1.51","coal_im":"2.71","coal_vm":"25.52","coal_ash":"23.39","coal_gcv_adb":"5648","coal_gcv_arb":"5648","coal_ncv_adb":"5436","coal_ncv_arb":"5436","lsf_rm":"110.65","sm_rm":"2.27","am_rm":"1.16","r90_rm1":"21.17","r212_rm1":"2.28","r90_rm2":"13.45","r212_rm2":"1.15","lsf_kf":"120.92","sm_kf":"2.10","am_kf":"1.22","r90_kf":"18.28","r212_kf":"1.60","ltrwt_ck":"1265.8","free_lime":"3.25","lsf_ck":"100.38","sm_ck":"2.26","am_ck":"1.27","c3s_ck":"61.01","c2s_ck":"13.54","c3a_ck":"6.70","c4af_ck":"12.44","liquid_ck":"26.45"}$qc021$::jsonb
 WHERE form_type = 'quality'
   AND record_date = '2026-04-21';
