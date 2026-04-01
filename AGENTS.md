# Agent Playbook

## General Debugging Habits
- When chart markers or gauges should mirror a live summary metric, source the marker from the latest summary payload first and treat historical samples as a fallback so the visual stays anchored to the freshest reading.
- While normalising price or unit data from external inputs, inspect the magnitude before applying conversions—values already provided in cents or base units often ship without an explicit unit field, and blindly multiplying them can inflate downstream cost calculations.


# Commit Rule
Commit as "conventional commit" style. No co-author.
Any commit should clearly state the reason for the change - and be well enough defined that a very competent LLM could re-author the changes from the previous state. You must take hints from previous prompts to capture developer intent. 
Ideally 3 lines, not more - If that is not possible, split up the commit into multiple