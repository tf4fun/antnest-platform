UPDATE agent_controller.run_admissions
SET terminal_report = jsonb_set(
    terminal_report,
    '{unknown_effect_source}',
    '"unclassified"'::jsonb,
    true
)
WHERE terminal_report ->> 'terminal_class' = 'unresolved'
  AND COALESCE(terminal_report ->> 'unknown_effect_source', '') = '';
