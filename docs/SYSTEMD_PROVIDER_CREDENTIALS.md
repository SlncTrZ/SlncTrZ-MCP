# Systemd provider credential references

Linux owners can reference an existing systemd runtime credential without copying its
value into the gateway credential store. The owner-managed credential descriptor is:

```json
{
  "kind": "systemd-bearer",
  "unit": "example-factory.service",
  "credential": "provider-token"
}
```

Store this descriptor under an ordinary gateway credential reference and include that
reference in the provider manifest's `credentialRefs`. Provision the descriptor file in
the owner-managed credential directory with the same private permissions as other refs;
the Owner Console's raw-token form does not provision systemd references.
The provider remains a normal Streamable HTTP integration; resolution supplies an
internal Bearer header without changing its manifest or the public tool surface.

Resolution reads `/run/credentials/<unit>/<credential>` using the gateway OS identity.
The supplying service must be running, and its credential must be readable by that identity.
The file must be private and owned by that identity, or owned by root with root group.
Root-owned systemd credentials may carry a group-read ACL mask to grant read access to
the gateway identity. Group writes/execute and all other permissions remain forbidden.
The OS still enforces the effective ACL; the gateway does not acquire new permissions.
Symlinked unit directories/files, non-regular files (including FIFOs), invalid names,
missing files, values larger than 16 KiB, empty values and embedded whitespace/control
characters fail closed. Surrounding whitespace is trimmed before validation.

Every resolution reads the current runtime value, so rotation is observed at the next
provider resolution. Existing transport sessions retain their resolved credentials
until they reconnect/reload. Listing returns only metadata and never reads the runtime secret.
Non-Linux resolution returns an explicit unsupported-platform error.

TLS trust is independent of authentication. For a private provider certificate, configure
the gateway service's `NODE_EXTRA_CA_CERTS` to the owner-approved public CA/certificate
file and restart the gateway. Retain hostname and certificate verification.

For upgrades, preserve the service identity and encrypted credential source. Do not
persist the decrypted value, disable TLS verification or copy host-specific descriptors
into a public source repository. This change is not present in the published v0.4.2 binaries;
no release is published by this change.

See [ADR-029](adr/adr-029-systemd-provider-credential-references.md).
