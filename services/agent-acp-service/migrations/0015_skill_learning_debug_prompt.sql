ALTER TABLE learning_tasks
    DROP CONSTRAINT learning_tasks_review_prompt_version_check,
    ADD CONSTRAINT learning_tasks_review_prompt_version_check
        CHECK (review_prompt_version IN (1, 2));
