"""
ENGINE-TWIN: Explainable AI (XAI) Package
Feature attribution, SHAP surrogate explanations, and structured operator alert generation.
"""
from .attribution import GradientAttributionExplainer
from .alert_generator import AlertGenerator, OperatorAlert

__all__ = [
    "GradientAttributionExplainer",
    "AlertGenerator",
    "OperatorAlert",
]
