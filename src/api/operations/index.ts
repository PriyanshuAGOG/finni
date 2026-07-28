// Each operation module calls `defineOperation` at module load time, which
// registers it immediately. Importing every module for its side effects is
// therefore sufficient -- there is no separate registration step, so the
// registry can never contain an operation that these imports didn't also
// bring into scope.
import './knowledge';
import './sources';
import './collections';
import './taxonomy';
import './claims';
import './annotations';
import './research';
import './briefs';
import './content';
import './processing';
import './confirmations';
import './audit';
import './files';
import './admin';
import './team';

let registered = false;

/**
 * Ensures the operation modules have been imported. Safe to call more
 * than once; the module graph is only evaluated the first time.
 */
export function registerOperations(): void {
  registered = true;
}

void registered;
