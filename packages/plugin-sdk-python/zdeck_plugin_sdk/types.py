"""Author-facing types. Wire keys deliberately match the TypeScript SDK."""
from typing import Literal, TypedDict, Union

Json = Union[None, bool, int, float, str, list["Json"], dict[str, "Json"]]
Args = dict[str, Union[int, bool]]
State = dict[str, Json]
SettingsValues = dict[str, str]


class IntegerControl(TypedDict):
    step: int


class _BooleanControl(TypedDict):
    stateKey: str


class BooleanControl(_BooleanControl, total=False):
    entityKey: str


class _IntegerConfig(TypedDict):
    type: Literal["integer"]
    minimum: int
    maximum: int


class IntegerConfig(_IntegerConfig, total=False):
    control: IntegerControl
    choicesKey: str


class _BooleanConfig(TypedDict):
    type: Literal["boolean"]


class BooleanConfig(_BooleanConfig, total=False):
    control: BooleanControl


class Observation(TypedDict):
    value: Union[None, bool, float]
    unit: str
    observedAtMs: int


class _Choice(TypedDict):
    """Display-only choicesKey array entry; app validates bounds, plugin validates binding."""
    value: int
    label: str
    available: bool


class Choice(_Choice, total=False):
    description: str
    observation: Observation


class Action(TypedDict):
    id: str
    title: str
    config: dict[str, Union[IntegerConfig, BooleanConfig]]


class ValueBinding(Action):
    stateKey: str
    entityKey: str


class SettingsField(TypedDict):
    type: Literal["text", "secret"]
    label: str


Settings = dict[str, SettingsField]


class Icon(TypedDict):
    id: str
    title: str
    category: str
    src: str


class _Manifest(TypedDict):
    id: str
    version: str
    protocolVersion: Literal[1]
    actions: list[Action]


class Manifest(_Manifest, total=False):
    icons: list[Icon]
    icon: str
    settings: Settings
    values: list[ValueBinding]
