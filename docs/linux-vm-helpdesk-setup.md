# Helpdesk Linux VM Setup Guide

Create a separate Linux virtual machine on your existing physical server, then move the helpdesk from Fly.io. Keep Supabase as the database so existing tickets, accounts and settings stay in place. This guide leaves the current Windows VM intact.

## 1 Identify the physical host

Ask the server administrator which platform hosts the Windows VM: Hyper-V, VMware or Proxmox. Open that platform on the physical host or its management console. Create the Linux VM alongside the Windows VM. Do not install it inside the existing Windows VM.

## 2 Gather what you need

- Administrator access to the virtualization platform and enough free host resources.

- An Ubuntu Server 24.04 LTS 64-bit ISO from Ubuntu, a reserved LAN IP, gateway and DNS details.

- Access to domain DNS, Fly, Supabase and the existing Power Automate flows. Keep credentials in your approved password store.

- A reviewed helpdesk release package and a current database backup. The public Git repository alone may not include every live change.

## 3 Create the Linux VM

Starting allocation: 2 virtual CPUs, 4 GB RAM, preferably 8 GB when building images, and a 60 GB SSD-backed virtual disk. Use an external or bridged network connected to the correct company LAN or server VLAN.

- Hyper-V: open Hyper-V Manager, select the host, then New > Virtual Machine. Name it Helpdesk Linux. Choose Generation 2, assign memory, select the external virtual switch, create the disk and attach the Ubuntu ISO. In VM Settings > Processor, set 2 virtual processors. In Security, use the Microsoft UEFI Certificate Authority Secure Boot template for Linux.

- VMware or Proxmox: use Create VM, select Ubuntu Linux 64-bit, assign the same resources, attach the ISO and select the correct bridged network. Ask the host administrator to confirm platform-specific settings.

Set automatic VM startup after the host boots, and orderly guest shutdown when the host shuts down. Reuse an approved network switch; changing the host network can interrupt other VMs.

# Install and connect to Ubuntu

## 4 Install Ubuntu Server

- Start the VM and open its console. Select Try or Install Ubuntu Server, then choose language and keyboard.

- Select Ubuntu Server without a desktop. Set networking using the reserved address or a DHCP reservation arranged by the network administrator.

- For storage, select only the new VM virtual disk. Review the disk summary before confirming installation.

- Create a named administrator account and use helpdesk-linux as the server name. Store the password securely.

- Select Install OpenSSH server. Skip optional featured server packages. Finish installation, eject the ISO and reboot.

## 5 Connect from your Windows computer

In the Ubuntu console, run hostname -I to see the LAN address. Open PowerShell on your Windows computer and replace the placeholders below.

```
ssh ADMIN_USER@VM_IP
```

Confirm the displayed SSH fingerprint with the VM administrator before accepting it. Use this SSH terminal for the remaining Linux commands.

```
sudo apt update
sudo apt upgrade -y
sudo apt install -y ca-certificates curl unzip nano
sudo reboot
```

Reconnect using SSH after the reboot. Use SSH keys for ongoing administration and allow management access only from approved LAN or VPN devices. Keep console access available while changing access rules.

## 6 Confirm networking and recovery

- Check that the VM can resolve DNS and reach the internet, Supabase and Microsoft services. Have the network administrator allow the outbound connections required by the database and tunnel.

- Ensure the physical host, router and network switches have backup power. Set the physical host to recover after a power failure.

Checkpoint: SSH works, Ubuntu is updated and the VM keeps the same LAN address after reboot. No production application has been started yet.

# Install Docker

## 7 Install the container software

Run these commands in the new Ubuntu VM. They add Docker's official package repository, install Docker and Compose, and start Docker automatically after reboot. These instructions assume a fresh Ubuntu 24.04 VM.

```
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

Create the Docker repository file:

```
sudo nano /etc/apt/sources.list.d/docker.sources
```

Paste these lines exactly. In nano, press Ctrl+O, Enter, then Ctrl+X to save and exit.

```
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
```

Install and check Docker:

```
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run hello-world
sudo docker compose version
```

If Ubuntu asks about restarting services, use the administrator-approved defaults. A Docker version and a successful hello-world message confirm installation.

## 8 Create the application folders

```
sudo mkdir -p /opt/helpdesk/app /opt/helpdesk/secrets
sudo chmod 700 /opt/helpdesk/secrets
```

Keep using sudo for Docker commands. Do not install Docker Desktop or a separate local PostgreSQL server for this migration.

# Prepare the helpdesk container

## 9 Transfer the reviewed release

Ask the application maintainer to supply a ZIP of the reviewed release, including the Dockerfile, package files, client, server and committed Prisma migrations. Exclude credentials, development databases, backups and node_modules. Transfer it securely, then extract it into /opt/helpdesk/app.

The Dockerfile must be directly at /opt/helpdesk/app/Dockerfile, not inside an extra ZIP folder. Include .dockerignore so private configuration is excluded from the image. The maintainer should verify that the release includes the intended intake fixes.

## 10 Create the Compose file

```
sudo nano /opt/helpdesk/compose.yaml
```

Paste the following. Keep the indentation exactly as shown.

```
services:
  helpdesk:
    build: ./app
    image: helpdesk:approved
    restart: unless-stopped
    env_file:
      - ./secrets/helpdesk.env
    environment:
      NODE_ENV: production
      PORT: "4000"
    ports:
      - "127.0.0.1:4000:4000"
    volumes:
      - attachments:/app/server/data/attachments
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  attachments:
```

The application port is local to the VM. The Cloudflare connector will run on the VM and reach it there. The volume retains cached attachment files between container replacements.

# Configure secrets and public access

## 11 Copy the existing production configuration

```
sudo nano /opt/helpdesk/secrets/helpdesk.env
```

Have the application maintainer transfer the approved production values securely. Use one NAME=value per line. Preserve quoting where required, especially for values containing dollar signs. Never put this file in the application ZIP or Git.

- Database: DATABASE_URL and DIRECT_URL for the existing Supabase database.

- Secrets: preserve JWT_SECRET, STATUS_LINK_SECRET if configured, and any other encryption or signing keys. Changing JWT_SECRET can make queued notification payloads unreadable.

- Email: preserve the active POWER_AUTOMATE_* settings, including intake and flow keys, gateway URL, mailbox and outbound switch. Keep unused Graph and IMAP pollers disabled as in production.

- Links and features: preserve PORTAL_BASE_URL and any active provider keys or other production settings. Do not copy examples over live values.

```
sudo chmod 600 /opt/helpdesk/secrets/helpdesk.env
cd /opt/helpdesk
sudo docker compose config --quiet
sudo docker compose build
```

Build only for now. Do not start the application against production while Fly is still running. Do not print or share the expanded Compose configuration because it may contain secrets.

## 12 Prepare HTTPS access

Recommended path: use a Cloudflare Tunnel if the organisation permits it and the domain is managed through Cloudflare. If not, ask the network administrator to configure an approved HTTPS reverse proxy and DNS route instead.

- In Cloudflare One, open Networks > Connectors > Cloudflare Tunnels and create a cloudflared tunnel named Helpdesk Linux.

- Choose the Linux installation option and run the installation and service command supplied by the dashboard on the VM. Treat the included tunnel token as a secret. Confirm the connector shows Healthy.

- Prepare a published application route for the helpdesk hostname to HTTP at localhost:4000. Apply the production DNS switch during cutover, not while Fly is still serving users.

Retain the existing hostname when possible. Power Automate must reach /api/integrations/power-automate/email and requesters must reach confirmation links. Do not place an interactive access login in front of these endpoints. The helpdesk keeps its own authentication.

# Move the live helpdesk

## 13 Perform the cutover

Arrange a short maintenance window. Keep the Fly deployment available for rollback, but do not run both application instances. The application starts background workers when it starts.

- 1. Verify a fresh Supabase backup and record how to restore it. Store the production configuration securely. Confirm the new image has built successfully.

- 2. Ask staff to pause ticket updates. Pause the Power Automate inbound trigger and record the last successfully processed message. Plan to replay messages received during the pause from the mailbox.

- 3. Stop the Fly application machine and confirm no application instance remains running there. Prevent the old machine from automatically restarting.

- 4. If the approved release has pending database migrations, have the maintainer run the command below once. Do not use migrate reset, db push or demo seeding.

```
cd /opt/helpdesk
sudo docker compose run --rm --no-deps helpdesk npm run db:deploy --prefix server
```

- 5. Start the new application and check local health:

```
sudo docker compose up -d
sudo docker compose ps
curl --fail http://127.0.0.1:4000/api/health
```

Expected health response: {"ok":true}. If it fails, inspect logs locally with sudo docker compose logs --tail=100 helpdesk. Do not share logs containing private operational details.

- 6. Switch the existing helpdesk hostname to the VM tunnel or approved proxy. Verify HTTPS and sign in through the public hostname. Allow for DNS cache delays.

- 7. If the hostname changes, update PORTAL_BASE_URL, restart the container and update the Power Automate destination URL. Preserve its intake authentication header. Previously sent links on the old hostname need a continuing route.

- 8. Resume Power Automate intake. Reconcile and replay messages from the paused interval so no email is lost.

## If the cutover fails

Pause inbound delivery, stop the VM application with sudo docker compose stop, then restore routing and start only the old Fly instance. Resume delivery and reconcile the pause. Consult the maintainer before rollback if a schema change is incompatible. Do not restore an old database backup over new tickets as a routine rollback.

# Verify and maintain the server

## 14 Complete the final checks

- Sign in with an existing account. Confirm ticket history, assignment groups and settings are present.

- Send one agreed test request and confirm one ticket, the correct assignment, and expected outgoing notifications. Check a received reply attaches to that ticket.

- View an older attachment and test a requester resolution confirmation using an agreed test ticket.

- Confirm the non-ticket intake exclusions are still present. Verify public health through the helpdesk hostname.

- During the maintenance window, reboot the VM. Confirm Docker, the helpdesk and the tunnel return automatically. Confirm Fly remains stopped.

## 15 Keep the service reliable

- Daily: check health monitoring, available disk space, inbound flow failures and notification delivery failures.

- Backups: keep database backups and encrypted copies of configuration outside this physical server. Test database restoration to a separate environment. A VM snapshot alone is not a database backup.

- Maintenance: schedule Ubuntu and container updates; retain a known-good image and keep a written update and rollback procedure. Never run tests against production Supabase.

Useful commands from /opt/helpdesk:

```
sudo docker compose ps
sudo docker compose logs --tail=100 helpdesk
sudo docker compose restart helpdesk
sudo systemctl status cloudflared
df -h
```

Moving the application removes the need for future Fly compute hosting once it is retired. Supabase, Microsoft services, internet and power are still required. Existing Fly invoices remain payable.

## Official reference guides

Ubuntu ISO and installation
https://ubuntu.com/download/server
https://ubuntu.com/server/docs/tutorial/

Docker installation
https://docs.docker.com/engine/install/ubuntu/

Hyper-V Linux Secure Boot
https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/learn-more/Generation-2-virtual-machine-security-settings-for-Hyper-V

Cloudflare tunnel setup
https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/
