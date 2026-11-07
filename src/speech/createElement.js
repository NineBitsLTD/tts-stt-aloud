/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Partial<HTMLElementTagNameMap[K]> & Record<string, any>} [props] properties of the element
 *   (`className`, `textContent`, `type`, `title`, …)
 * @param {...(Node | string)} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function createElement(tag, props = {}, ...children) {
    const element = document.createElement(tag);
    Object.assign(element, props);
    element.append(...children);
    return element;
}

/**
 * @param {string} name of a codicon
 * @returns {HTMLElement}
 */
export function createIcon(name) {
    return createElement('i', { className: `codicon codicon-${name}` });
}
