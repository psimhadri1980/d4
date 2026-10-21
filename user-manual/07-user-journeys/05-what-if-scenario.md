# Journey 5 — Model a what-if scenario and compare it

**Who:** planner or architect. **Goal:** see what happens if the legacy client database is retired earlier.

1. Press **+**, choose type **Scenario**, name it "Early retirement", **Create**.
2. In the Explorer toolbar select **Scenario: Early retirement**. A notice says you are viewing the baseline plus the scenario.
3. Open the legacy data store and **+ Add** the relationship change you want to test. The form says it will be added to the scenario, not the baseline.
4. Open **Compare**, set From = **— Baseline —** and To = **Early retirement**.

   ![Compare](../images/compare.png)
5. Review added, removed and changed relationships. Set both sides to different dates as well if you want to see timing.
6. Look at **Matrices › Data-store roles** with the scenario selected to see the effect on masters.
7. Share the Compare URL. Choose **— Baseline —** again to leave the scenario.

**Result:** a risk-free comparison; the baseline is untouched.
