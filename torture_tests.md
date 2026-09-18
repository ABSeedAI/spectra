My top 8 torture tests

1. Stripe-like payments / subscriptions — my #1 choice

Build a tiny billing system:

Customer
Product
Price
Subscription
Invoice
Payment
Refund
Coupon
Payment method

Then introduce:

failed payments
retries
prorations
subscription upgrades/downgrades
cancellation at period end vs immediately
refunds after cancellation
idempotency
webhook duplication
out-of-order webhooks
money rounding
tax
trial periods

This should expose whether Spectra can represent temporal state and invariants.

For example:

“A subscription is active until the end of its billing period after cancellation.”

That's deceptively simple. You need to distinguish:

cancel_requested
cancel_at
status
current_period_end
ended_at

and establish relationships between them.

Likely Spectra shortcoming: a vocabulary of entities/functions/attributes may describe what exists without adequately describing state machines and temporal invariants.

2. Collaborative Google Docs / Notion clone

Don't build the whole thing. Build:

Document
Block
User
Membership
Comment
Revision

Then add:

simultaneous edits
undo
version history
comments attached to blocks
deleting a block with comments
permissions changing while someone is editing
offline edits syncing later

Now ask Spectra to specify:

Alice edits paragraph 4 offline. Bob deletes paragraph 4. Alice reconnects.

What is supposed to happen?

This tests whether the specification can express concurrency and conflict resolution.

The important distinction is:

“A document contains blocks”

versus:

“A document is a sequence whose mutations are partially ordered and reconciled.”

That's a completely different level of semantics.

3. GitHub-ish pull request system

This one would be extremely revealing.

Entities:

Repository
Branch
Commit
PullRequest
Review
Comment
User
Check
Deployment

Then specify:

branch protection
required reviewers
stale approvals
force pushes
merge commits vs squash vs rebase
required CI checks
CODEOWNERS
merge queues
permissions
deleted branches
review dismissal

Now create deliberately conflicting requirements:

PR requires two approvals.

An approval becomes stale when new commits are pushed.

Admins may bypass branch protection.

Merge queue may merge after approval but before the UI reflects the latest state.

You're testing whether Spectra can express authorization + temporal rules + derived state + external events.

I'd expect this to generate a lot of useful questions.

4. Uber/DoorDash-style dispatch

This is my favorite non-software-engineering test.

Entities:

Customer
Driver
Vehicle
Trip
Location
Offer
Payment
Rating

Then:

customer requests ride
system offers ride to driver
driver accepts
another driver accepts simultaneously
driver cancels
customer cancels
driver loses GPS
driver goes offline
trip begins
payment fails
driver disputes fare

The interesting part is that the domain has multiple actors with competing actions.

You're no longer specifying:

acceptRide(ride)

You're specifying:

Under what conditions is this transition valid when other actors may simultaneously mutate the same underlying state?

That's a much harder problem.

5. Banking ledger

This might be the ultimate invariant test.

Don't build a banking UI. Build a ledger.

Account
LedgerEntry
Transaction
Transfer
Hold
Balance

Requirements:

transfers are atomic
debits can't exceed available funds
pending transactions affect available balance but not ledger balance
reversal creates compensating entries
duplicate requests must be idempotent
ledger entries cannot be edited
balances can be reconstructed from entries

Then deliberately ask for:

“Change the balance.”

A good specification system should almost scream:

No. Balance is derived state.

That's an excellent test of whether Spectra distinguishes:

stored state
derived state
immutable facts
commands
invariants

rather than treating everything as an attribute.

6. E-commerce inventory

This looks boring until you introduce concurrency.

Product
SKU
Warehouse
Inventory
Reservation
Order
Shipment
Return

Then:

1 item remains
Alice adds it to cart
Bob buys it
Alice checks out
payment succeeds
warehouse says item is damaged
order gets partially fulfilled
customer returns it
returned item fails inspection

Now ask:

At exactly what point does inventory decrease?

Possible answers:

cart
reservation
payment
order creation
shipment

Each has different semantics.

Then add two warehouses and inventory transfers.

This reveals whether Spectra can express ownership, reservations, lifecycle transitions, and consistency boundaries.

7. Slack/Discord-style messaging

This tests permissions and deletion semantics.

Entities:

Workspace
User
Channel
Membership
Message
Thread
Reaction
Attachment

Then:

public/private channels
roles
kicked users
deleted users
message editing
message deletion
thread deletion
retention policies
scheduled messages
bots
mentions
unread state

The killer requirement:

User Alice is removed from a private channel. What can Alice still see from its history?

Then:

Alice's account is deleted. What happens to messages Alice authored?

That's where a simple entity graph becomes inadequate.

8. A real-world workflow: healthcare appointment system

This is useful because the domain itself is messy.

Patient
Provider
Appointment
Location
Insurance
Referral
Prescription
Availability

Then:

appointment holds
double booking
provider cancellation
patient cancellation
no-shows
recurring appointments
referral expiration
insurance authorization
timezone differences
appointment rescheduling

The interesting thing isn't the CRUD.

It's:

What exactly does “available” mean?

That single word can imply several different entities and constraints.

I'd actually run a progression

Rather than picking one monster app, I'd make a Spectra torture-test suite:

Test	What it probes
Todo	Basic vocabulary
Inventory	Derived state + lifecycle
Payments	Temporal semantics + idempotency
GitHub PRs	Permissions + derived state
Messaging	Deletion/history/authorization
Dispatch	Concurrency
Collaborative editor	Conflict resolution
Ledger	Invariants + immutability

The goal shouldn't be:

“Can Spectra represent this application?”

That's too easy.

Instead, for each app I'd record where the specification becomes awkward.

I'd create a taxonomy like:

A  Entity modeling
B  Relationships
C  State machines
D  Temporal constraints
E  Invariants
F  Derived state
G  Authorization
H  Concurrency
I  Idempotency
J  External events
K  Failure semantics
L  Versioning/migration
M  Non-functional requirements
N  Human ambiguity
O  Cross-domain invariants

Then every time you hit something Spectra can't naturally express, don't immediately add a feature.

Ask:

What is the smallest new primitive that makes this expressible?

That's where I think the really interesting design work is.

For example, if the billing test repeatedly needs:

Subscription
  status = active
  transition → canceled
  when = period_end

you might discover that Spectra needs a first-class state machine primitive.

If the ledger keeps needing:

sum(entries) == balance

you've discovered a need for invariants.

If the dispatch system needs:

accept(request)
only_if(version == expected_version)

you've discovered concurrency semantics.

And if all three keep appearing, that's evidence that the underlying model should evolve beyond a glossary into something closer to a domain semantics IR.

One particularly evil test

I'd make a tiny banking system with only 6–8 entities, then give Spectra requirements containing:

state transitions
immutable events
derived balances
authorization
idempotency
retries
scheduled transitions
concurrent commands
external webhook events
invariants

If Spectra can make that feel natural—and the agent can implement it without inventing semantics—I would become much more bullish on the underlying thesis.

The repo already deliberately uses seemingly simple Todo edge cases like completing an already-completed task and deleting a project containing tasks, so escalating from those edge cases into these semantic stress tests feels like the natural next experiment.