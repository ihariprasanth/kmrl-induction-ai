# FLEET-CTRL — Restricted Access Credentials

This app has **no sign-up / self-registration**. The ONLY way in is one of the 21 rows
seeded into `public.app_users` by `supabase/schema.sql`. Nothing else is allowed to log in.

Run `supabase/schema.sql` once in your Supabase SQL editor to create these accounts.

## HOD (1 account — full access)

| Username | Password  |
|----------|-----------|
| kathir   | kathir01  |

## Technicians / Operators (20 accounts)

| Username | Password    | Name             |
|----------|-------------|------------------|
| tech01   | Metro125!   | Arun Kumar       |
| tech02   | Aluva328#   | Bipin Das        |
| tech03   | Metro792@   | Cibi Chandran    |
| tech04   | Transit532@ | Deepak Nair      |
| tech05   | Rail195#    | Elango R         |
| tech06   | Aluva617@   | Farook Ali       |
| tech07   | Bogie303$   | Gokul Krishna    |
| tech08   | Aluva559!   | Hari Krishnan    |
| tech09   | Rail877#    | Ijas Rahman      |
| tech10   | Coach448!   | Jithin P         |
| tech11   | Kochi320!   | Kannan S         |
| tech12   | Metro194$   | Lakshman V       |
| tech13   | Metro467!   | Muthu Kumar      |
| tech14   | Transit370@ | Naveen Raj       |
| tech15   | Depot649@   | Om Prakash       |
| tech16   | Coach180!   | Prasad K         |
| tech17   | Transit982! | Rajesh Menon     |
| tech18   | Transit296@ | Sanjay Varma     |
| tech19   | Rail777#    | Thomas Jacob     |
| tech20   | Track181#   | Vishnu Nair      |

## Rotating / managing accounts

Change a password:
```sql
update public.app_users set password = 'NEW_PASSWORD' where username = 'tech01';
```

Add a technician:
```sql
insert into public.app_users (username, password, name, role)
values ('tech21', 'NewPass1!', 'New Technician Name', 'OPERATOR');
```

Remove a technician:
```sql
delete from public.app_users where username = 'tech21';
```

Keep this file private — do not commit it to a public repo alongside real production passwords.
