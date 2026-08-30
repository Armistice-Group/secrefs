import os
from typing import Dict, List, Optional

from .parser import (
    ParsedSecretRef,
    SecRefParseError,
    is_secret_ref,
    parse_secret_ref,
    try_parse_secret_ref,
)
from .providers.aws import AWSSecretsManagerProvider
from .providers.base import ProviderHealth, SecretFetchError, SecretFetchRequest, SecretProvider
from .providers.local import LocalProvider
from .providers.vault import VaultProvider
from .resolver import (
    CheckResult,
    ProviderRegistry,
    ResolutionFailure,
    SecRefsResolutionError,
    check_references,
    expand_environ,
    expand_key_value_map,
)


def create_default_providers() -> Dict[str, SecretProvider]:
    """Builds the default provider registry: aws, vault, local."""
    return {
        "aws": AWSSecretsManagerProvider(),
        "vault": VaultProvider(),
        "local": LocalProvider(),
    }


class SecRefs:
    """Mirrors the Node SDK's `secRefs.init()` / `expandEnv()` / `expandString()` API."""

    def __init__(
        self,
        providers: Optional[Dict[str, SecretProvider]] = None,
        strict: bool = True,
    ) -> None:
        self.providers: Dict[str, SecretProvider] = providers or create_default_providers()
        self.strict = strict

    async def init(self) -> List[str]:
        """Expands sec:// values found in os.environ, mutating it in place."""
        return await expand_environ(self.providers, strict=self.strict)

    async def expand_env(self, env: Dict[str, Optional[str]]) -> Dict[str, str]:
        """Expands sec:// values in an arbitrary key/value map without touching os.environ."""
        return await expand_key_value_map(env, self.providers, strict=self.strict)

    async def expand_string(self, value: str) -> str:
        """Expands a single string if it's a sec:// reference; otherwise returns it unchanged."""
        if not is_secret_ref(value):
            return value
        result = await expand_key_value_map({"__value__": value}, self.providers, strict=True)
        return result["__value__"]

    async def check(self, env: Optional[Dict[str, Optional[str]]] = None) -> List[CheckResult]:
        """Dry-run validation of every sec:// reference in `env` (defaults to os.environ)."""
        return await check_references(env if env is not None else dict(os.environ), self.providers)


sec_refs = SecRefs()

__all__ = [
    "SecRefs",
    "sec_refs",
    "create_default_providers",
    "ParsedSecretRef",
    "SecRefParseError",
    "is_secret_ref",
    "parse_secret_ref",
    "try_parse_secret_ref",
    "AWSSecretsManagerProvider",
    "VaultProvider",
    "LocalProvider",
    "SecretProvider",
    "SecretFetchRequest",
    "SecretFetchError",
    "ProviderHealth",
    "SecRefsResolutionError",
    "ResolutionFailure",
    "CheckResult",
    "ProviderRegistry",
    "expand_environ",
    "expand_key_value_map",
    "check_references",
]
