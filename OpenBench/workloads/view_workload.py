# # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #
#                                                                             #
#   OpenBench is a chess engine testing framework authored by Andrew Grant.   #
#   <https://github.com/AndyGrant/OpenBench>           <andrew@grantnet.us>   #
#                                                                             #
#   OpenBench is free software: you can redistribute it and/or modify         #
#   it under the terms of the GNU General Public License as published by      #
#   the Free Software Foundation, either version 3 of the License, or         #
#   (at your option) any later version.                                       #
#                                                                             #
#   OpenBench is distributed in the hope that it will be useful,              #
#   but WITHOUT ANY WARRANTY; without even the implied warranty of            #
#   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the             #
#   GNU General Public License for more details.                              #
#                                                                             #
#   You should have received a copy of the GNU General Public License         #
#   along with this program.  If not, see <http://www.gnu.org/licenses/>.     #
#                                                                             #
# # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # # #

# Module serves a singular purpose, to invoke:
# >>> view_workload(request, workload, type)
#
# A Workload can be a "TEST", which is an SPRT, or FIXED type
# A Workload can be a "TUNE", which is an SPSA tuning session
# A Workload can be a "DATAGEN", which is a Data Generation session

import datetime
import OpenBench.config
import OpenBench.views

from django.utils import timezone
from OpenBench.models import *

def view_workload(request, workload, workload_type):

    assert workload_type in [ 'TEST', 'TUNE', 'DATAGEN' ]

    data = {
        'workload' : workload,
        'results'  : [],
        'dev_network_url' : '/networks/%s/' % (workload.dev_engine),
        'base_network_url' : '/networks/%s/' % (workload.base_engine),
    }

    for result in Result.objects.select_related('machine__user').filter(test=workload):
        data['results'].append({ 'data' : result, 'active' : is_active(result) })

    network_pairs = set()
    if workload.dev_network:
        network_pairs.add((workload.dev_engine, workload.dev_network))
    if workload.base_network:
        network_pairs.add((workload.base_engine, workload.base_network))

    if network_pairs:
        engines = [engine for engine, _ in network_pairs]
        shas = [sha for _, sha in network_pairs]
        existing_networks = set(Network.objects.filter(engine__in=engines, sha256__in=shas).values_list('engine', 'sha256'))

        if (workload.dev_engine, workload.dev_network) in existing_networks:
            data['dev_network_url'] = '/networks/%s/download/%s/' % (workload.dev_engine, workload.dev_network)

        if (workload.base_engine, workload.base_network) in existing_networks:
            data['base_network_url'] = '/networks/%s/download/%s/' % (workload.base_engine, workload.base_network)

    if workload.test_mode == 'SPRT':
        data['llr_history_endpoint'] = '/api/test/%d/llr-history/' % (workload.id)

    if workload.book_name in OpenBench.config.OPENBENCH_CONFIG['books']:
        data['book_url'] = OpenBench.config.OPENBENCH_CONFIG['books'][workload.book_name]['source']

    if workload_type == 'TEST':
        data['type']            = workload_type
        data['dev_text']        = 'Dev'

    if workload_type == 'TUNE':
        data['type']            = workload_type
        data['dev_text']        = ''

    if workload_type == 'DATAGEN':
        data['type']            = workload_type
        data['dev_text']        = 'Dev'

    return OpenBench.views.render(request, 'workload.html', data)

def is_active(result):

    # One minute prior to now
    target = datetime.datetime.utcnow()
    target = target.replace(tzinfo=timezone.utc)
    target = target - datetime.timedelta(minutes=1)

    return result.test_id == result.machine.workload and result.machine.updated >= target
