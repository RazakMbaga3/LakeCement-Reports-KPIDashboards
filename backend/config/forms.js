/*
  config/forms.js — the canonical list of daily-report form types.
  Must match the formId strings the frontend sends via initFormPersist('...')
  across all 11 form/report pages. Single source — routes/reports.js and
  routes/insights.js both validate against this.
*/
const VALID_FORMS = [
  'production', 'mines', 'power-plant', 'dispatch', 'quality',
  'power-cons', 'limestone', 'materials',
  'pile-quality', 'cpp', 'stoppage'
];

module.exports = { VALID_FORMS };
