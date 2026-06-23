# Ansible Configuration Management

## Boundary

Governs Ansible configuration management: idempotent task design, role and inventory structure, handlers and notify, ansible-vault secret handling, check mode, fact gathering, and error control.

## Out of Scope

Not cloud resource provisioning topology (platform.cloud) and not OS-level system internals (code.systems); this pack covers how to express convergent configuration with Ansible.

## Default Posture

Idempotency and blast radius are the dominant axes: declare desired state rather than commands, dry-run with check mode and --diff before applying, and treat production inventory as a human-gated boundary.

## Provenance

domain_pack:platform.ansible
