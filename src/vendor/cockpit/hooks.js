// SPDX-License-Identifier: LGPL-2.1-or-later
// Derived from Cockpit 370 pkg/lib/hooks.ts.
import { useEffect, useReducer } from 'react';

export function useEvent(obj, event) {
    const [, forceUpdate] = useReducer(value => value + 1, 0);
    useEffect(() => {
        if (!obj) return undefined;
        obj.addEventListener(event, forceUpdate);
        return () => obj.removeEventListener(event, forceUpdate);
    }, [obj, event]);
}
