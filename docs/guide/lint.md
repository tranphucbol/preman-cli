# Linting

A Postman request file can be valid and still be wrong in a way nothing tells you about. Write
multipart parts under `body.content` instead of `body.formdata` and the file parses, the app paints
an empty grid, and a run sends no body and no `Content-Type` — silently, because preman only raises
that class of warning while a request is going out.

`preman lint` reads every request and reports those fields without sending anything:

```sh
preman lint                  # what will be ignored, and what cannot run
preman lint --strict -v      # warnings are fatal too, with the rule id on each line
preman lint --json           # the same findings, machine-readable
```

```text
  Paparazzi/Instances/Create Instance  postman/collections/Paparazzi/Instances/Create Instance.request.yaml
    error body.formdata  body.content is not read by type formdata, and body.formdata is absent: no body is sent
           rename body.content to body.formdata
```

An **error** means the request cannot do what it says — no body is sent, a named file is not on
disk, an auth type throws before the socket opens — and exits `1`. A **warning** means it runs, but
something you wrote is being dropped, and exits `0` unless you pass `--strict`, which is what a CI
job wants.

It says nothing about `{{tokens}}`. A variable a script sets on one request and reads on the next
is unresolved at rest for good reason, and a linter that flagged it would be wrong far more often
than right. See [ADR 057](../decisions/057-lint-restates-the-runner-rather-than-running-it.md).
