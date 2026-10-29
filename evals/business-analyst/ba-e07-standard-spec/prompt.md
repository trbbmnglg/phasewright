---
description: "E07: multiple roles, an integration, and coordinated acceptance get a Standard spec; E16: the template is read first"
tags: [business-analyst, invoked]
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

/phasewright:business-analyst Write a spec for letting team admins invite members by email. Draft it now from these answers: admins send invites from the Team page; the invitee gets an email with a link that expires after 7 days; accepting creates a Member account; members can't invite. Every new member must also be created in our CRM through its REST API, which the sales-ops team owns, and sales-ops has to sign off on the CRM fields before release. We haven't agreed how fast the invite email must arrive.
