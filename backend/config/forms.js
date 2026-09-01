/*
  config/forms.js — the canonical list of daily-report form types.
  Must match the formId strings the frontend sends via initFormPersist('...')
  across all 11 form/report pages. Single source — routes/reports.js and
  routes/insights.js both validate against this.
*/
/* 'power-plant' was retired 2026-08-31. It was in VALID_FORMS, in the MIS
   form catalogue and granted to the cpp role, but no page ever submitted it
   (power-plant-report.html calls initFormPersist('cpp')) and it never held a
   single row. Its only visible effect was a permanently 0% row on Entry
   Completeness and an always-missing section in the MIS daily pack. CPP data
   lives under the 'cpp' form type. */
const VALID_FORMS = [
  'production', 'mines', 'dispatch', 'quality',
  'power-cons', 'limestone', 'materials',
  'pile-quality', 'cpp', 'stoppage', 'sales-projection'
];

/* Which daily_reports.status values count as REAL reported data.

   Everything that reads daily_reports for analysis — the formula engine,
   the MIS daily/monthly packs, entry completeness, the anomaly baseline,
   the stoppage Pareto — used to read every row regardless of status, so an
   unfinished draft and a report an HOD had explicitly REJECTED carried the
   same weight in the KPIs as an approved one.

     approved         — signed off, or self-certified by an HOD
     pending_approval — genuinely reported, awaiting a signature. Excluding
                        it would blank today's dashboard until the HOD gets
                        to it, which is worse than showing it.
     draft            — excluded: work in progress, not yet reported
     rejected         — excluded: the HOD said this data is wrong

   Retrieval by the form pages themselves (GET /api/reports/...) is
   deliberately NOT filtered — an author must be able to reopen their own
   draft, and a rejected report must come back so it can be corrected. */
const REPORTED_STATUSES = ['approved', 'pending_approval'];

module.exports = { VALID_FORMS, REPORTED_STATUSES };
