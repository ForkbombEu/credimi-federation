# GitHub registry

Each JSON file in this directory registers one subordinate of the Credimi
test federation's Trust Anchor (`https://federation.credimi.io`). The
federation is for development and interoperability testing; joining it
confers no accreditation or certification.

## Join or update your entry by pull request

1. Publish your Entity Configuration at
   `<your Entity Identifier>/.well-known/openid-federation`, signed with your
   federation key, with `https://federation.credimi.io` in `authority_hints`.
   See [docs/INTEGRATION.md](../docs/INTEGRATION.md).
2. Add one file to this directory, named after your Entity Identifier:
   remove `https://` and a trailing `/`, replace every run of characters other
   than letters, digits, `.` and `-` with `_`, and append `.json`. For
   `https://issuer.example.org/issuers/pid` the file is
   `issuer.example.org_issuers_pid.json`.
3. Put exactly one entry in it, with your **public** federation keys only:

   ```json
   {
     "entity_id": "https://issuer.example.org/issuers/pid",
     "enabled": true,
     "entity_types": ["openid_credential_issuer"],
     "jwks": {
       "keys": [
         {
           "kty": "EC",
           "crv": "P-256",
           "x": "…",
           "y": "…",
           "kid": "…",
           "alg": "ES256",
           "use": "sig"
         }
       ]
     }
   }
   ```

   Optional members are `metadata_policy` and `constraints`; the README's
   "Registering a subordinate" section lists every member and its rules.

4. Open a pull request. The **Registry** workflow validates the whole
   directory and fetches the live Entity Configuration of every enabled entry
   you add or change. Every check must pass: the Entity Configuration is
   reachable, issued by your entity about itself, signed with a key in your
   file, publishing exactly the keys in your file, naming this Trust Anchor in
   `authority_hints`, and unexpired. The job summary shows the result of each
   check.
5. A maintainer reviews and merges. Passing the checks proves that whoever
   controls your host publishes those keys; the merge is the decision to
   trust you. After the merge, the Trust Anchor is redeployed and serves your
   Subordinate Statement.

To rotate keys: publish the new public key next to the old one in your Entity
Configuration (still signing with the old key), and add it to your file in a
pull request. After the merge and redeploy, switch to signing with the new
key, remove the old key from your Entity Configuration, and remove it from
your file in a second pull request. Both pull requests must pass the checks.

Every Monday the **Registry health** workflow repeats the live checks for
every enabled member. If yours fails, it is listed in an issue labelled
`registry-health`; fix your Entity Configuration, or update your file by
pull request. Maintainers may disable or remove entries that keep failing.

To leave the federation, open a pull request that deletes your file.
