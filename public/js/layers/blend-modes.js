/**
 * Blend Modes
 * Definitions and utilities for layer blend modes
 *
 * @module layers/blend-modes
 */

/**
 * Available blend modes from Noisemaker's blendMode effect
 * Ordered as they appear in Photoshop (roughly)
 */
export const BLEND_MODES = [
    { id: 'mix', name: 'Normal', description: 'Standard alpha blending' },
    { id: 'multiply', name: 'Multiply', description: 'Darkens by multiplying colors' },
    { id: 'screen', name: 'Screen', description: 'Lightens by inverting, multiplying, inverting' },
    { id: 'overlay', name: 'Overlay', description: 'Combines multiply and screen' },
    { id: 'softLight', name: 'Soft Light', description: 'Gentle overlay effect' },
    { id: 'hardLight', name: 'Hard Light', description: 'Strong overlay effect' },
    { id: 'darken', name: 'Darken', description: 'Keeps darker pixels' },
    { id: 'lighten', name: 'Lighten', description: 'Keeps lighter pixels' },
    { id: 'dodge', name: 'Color Dodge', description: 'Brightens base by decreasing contrast' },
    { id: 'burn', name: 'Color Burn', description: 'Darkens base by increasing contrast' },
    { id: 'add', name: 'Add', description: 'Adds colors together (linear dodge)' },
    { id: 'subtract', name: 'Subtract', description: 'Subtracts blend from base' },
    { id: 'difference', name: 'Difference', description: 'Absolute difference of colors' },
    { id: 'exclusion', name: 'Exclusion', description: 'Similar to difference but lower contrast' },
    { id: 'negation', name: 'Negation', description: 'Inverts colors where they overlap' },
    { id: 'phoenix', name: 'Phoenix', description: 'Min minus max plus 1' }
]

/**
 * Get blend mode by ID
 * @param {string} id - Blend mode ID
 * @returns {object|null} Blend mode object or null
 */
export function getBlendMode(id) {
    return BLEND_MODES.find(m => m.id === id) || null
}

/**
 * Get blend mode name by ID
 * @param {string} id - Blend mode ID
 * @returns {string} Blend mode name or ID if not found
 */
export function getBlendModeName(id) {
    const mode = getBlendMode(id)
    return mode ? mode.name : id
}

/**
 * Get all blend mode IDs
 * @returns {string[]} Array of blend mode IDs
 */
export function getBlendModeIds() {
    return BLEND_MODES.map(m => m.id)
}
