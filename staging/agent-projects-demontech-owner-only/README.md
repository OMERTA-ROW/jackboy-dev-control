# DemonTech owner-only rule in the database (staged, not applied)

Security finding: any manager (admin) could switch on DemonTech checks for a project directly
through the database, skipping the app's owner-only check. `demontech_owner_only.sql` adds a
database trigger so only the owner can turn it on; managers can still turn it off.

Not applied because `drizzle/migrations/` is behind the live history (0075–0077 exist only as
reference copies), so recording a new migration needs the owner's approval of its number.
Nothing here runs against any database.
