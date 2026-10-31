# Modules

D4's screens come in **modules**: Explore, Queries, Plan and govern, Data management, Reporting and Administration. Each is loaded into the page on its own, so a module can be updated, turned off or rolled back without changing the rest of D4. **Admin › Modules** (admins only) shows which modules your tenant runs and lets you change that.

## The list

**Registered modules** shows each module's **Module** (title and name), **Release** (its version), **Owner**, **Status** (on or off) and **Entry** (where D4 loads it from). Buttons on each row:

- **New release** fills the form below with the module's details, to record a newer version.
- **Turn off / Turn on**. A turned-off module disappears from everyone's menu, and its pages show *This part of D4 is unavailable at the moment*.
- **Remove** deletes the module from your tenant (you are asked to confirm).

Changes reach open pages within about 30 seconds, or as soon as someone returns to the D4 tab, without a reload: a new release replaces the old one on a page that is open, and a turned-off module unmounts.

## Register a module or record a release

Fill **Name** (lower-case letters, digits and dashes), **Title**, **Description**, **Owner**, **Entry**, **Version**, and **Framework** (React, Plain JavaScript or Other), then press **Register module** (or **Save release** for a module already listed).

The **Entry** must be a path D4 itself serves: `/mfe/<name>/…` for a module built into the platform, or the path of a release uploaded for your tenant (`/mfe/_r/…`). D4 refuses anything else, because a module's code runs in every member's browser.

## Releases and rollback

Your platform team uploads a release (a module build with a version), usually from its delivery pipeline. Uploading does not change anything users see. Activating a version does, and rolling back is activating an earlier version again; earlier versions stay available, so a rollback takes effect within seconds. D4 refuses a release built for a different version of the platform, and shows the module as unavailable rather than loading it.

## When a module is unavailable

If a module cannot be loaded (it is turned off, its release is missing, or it was built for another platform version), its pages show *This part of D4 is unavailable at the moment* and its menu items are hidden. Every other module keeps working. See [Troubleshooting](../08-reference/troubleshooting.md).
