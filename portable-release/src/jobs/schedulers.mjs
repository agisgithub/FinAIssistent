import { AppError } from '../errors.mjs';
export class Schedulers {
  constructor(schedulers){this.schedulers=schedulers;}
  owner(job){const owners=this.schedulers.filter(s=>s.owns(job));if(owners.length>1)throw new AppError('INTERNAL_ERROR');return owners[0]??null;}
  owns(job){return this.owner(job)!==null;}
  tick(){return this.schedulers.flatMap(s=>s.tick());}
  runJob(job){const owner=this.owner(job);if(!owner)throw new AppError('INPUT_INVALID');return owner.runJob(job);}
  authorizeDelivery(row){return this.schedulers.every(s=>s.authorizeDelivery(row));}
  prune(days){for(const scheduler of this.schedulers)scheduler.prune(days);}
}
