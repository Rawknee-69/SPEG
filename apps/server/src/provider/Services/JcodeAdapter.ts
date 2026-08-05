/**
 * JcodeAdapter — shape type for the Jcode provider adapter.
 *
 * Mirrors `OpenCodeAdapter`: the per-instance Jcode adapter contract is the
 * generic `ProviderAdapterShape` with the branded driver kind as the nominal
 * discriminant. The driver (`Drivers/JcodeDriver`) bundles one adapter per
 * instance as a captured closure, so there is no `Context.Service` tag.
 *
 * @module JcodeAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * JcodeAdapterShape — per-instance Jcode adapter contract.
 */
export interface JcodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
