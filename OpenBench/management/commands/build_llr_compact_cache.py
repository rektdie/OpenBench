import os

from django.core.management.base import BaseCommand

import OpenBench.utils
from OpenBench.models import Test


class Command(BaseCommand):

    help = 'Build compact LLR history caches for SPRT tests'

    def add_arguments(self, parser):
        parser.add_argument(
            '--force',
            action='store_true',
            help='Rebuild compact caches even when they already look fresh',
        )

    def handle(self, *args, **options):
        rebuilt = 0
        skipped = 0
        missing = 0

        tests = Test.objects.filter(test_mode='SPRT').order_by('id')

        for test in tests:
            history_path = OpenBench.utils.llr_history_path(test.id)
            if not os.path.exists(history_path):
                missing += 1
                continue

            if not options['force'] and OpenBench.utils.has_fresh_compact_llr_history(test):
                skipped += 1
                continue

            history = OpenBench.utils.load_llr_history(test)
            OpenBench.utils.write_compact_llr_history(test, history)
            rebuilt += 1

        self.stdout.write(
            self.style.SUCCESS(
                'LLR compact cache complete: rebuilt %d, skipped %d, missing %d'
                % (rebuilt, skipped, missing)
            )
        )
