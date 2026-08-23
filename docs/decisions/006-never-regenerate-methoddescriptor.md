# 006: The app never regenerates `methodDescriptor`

Status: Accepted

## Decision

The desktop app never generates or rewrites the base64 `FileDescriptorSet` in a gRPC request.
Existing descriptors are preserved byte for byte. Changing which method a request calls means
editing `methodPath` and `schema.location`, and nothing else.

## Rationale

The descriptor is Postman's offline schema: it is what lets a request run when the `.proto` is not
on the machine. Producing one correctly means resolving the full transitive import closure of a
proto file and serialising a `FileDescriptorSet` that matches what `protoc` would have emitted.

Getting that subtly wrong is worse than not doing it. A descriptor that is present but incomplete
fails at invoke time with a message about a missing type, in a request that looks fine, on a
machine that may not have the proto to check against.

The alternatives were shipping `protoc` in the bundle, or shelling out to whatever `protoc` the
user has. The first is a large binary and a version-matching problem; the second is a dependency
the CLI does not have.

## Consequences

**This is a real limitation, and it was chosen without asking.** Adding a brand-new gRPC method
through the UI produces a request with `schema.source: file` and no descriptor. It runs correctly
as long as the `.proto` resolves, and loses the offline path until somebody regenerates the
descriptor with `protoc` or re-exports from Postman.

Requests imported from an existing workspace — where the descriptors came from Postman — keep
working exactly as they did, which is the case that matters most.
