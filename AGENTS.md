# Bryti operations

- The production Bryti instance runs on `hetzner-01`, not on this workstation. Check that host before searching for a local process. Context Lens is a development setup, not the production service.
- Infrastructure and deployment instructions live in `/home/lars/xithing/infra/ansible/README.md`, with the release playbook at `ansible/playbooks/deploy-bryti.yml` in that repository.
- Production uses `bryti.service`, application files in `/opt/bryti`, and persistent state and runtime configuration in `/mnt/data/bryti`.
- An explicitly authorized restart uses `ssh hetzner-01 'systemctl restart bryti.service'`. Verify the service is running and `Bryti ready!` appears in the journal for the new systemd invocation. Do not print configuration, environment files, or credentials.
- Restarting production does not deploy local code or configuration changes. Deployment and production configuration changes require separate authorization; never copy the workstation's entire data directory to production.
